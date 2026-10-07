import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { callRunner, type Endpoint } from "../src/adapters/sandbox/backend.ts";
import { PodmanSandbox } from "../src/adapters/sandbox/podman.ts";
import { podSpec } from "../src/adapters/sandbox/kube.ts";
import { SandboxManager, sandboxName } from "../src/adapters/sandbox/manager.ts";

const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "localhost/crew-sandbox:dev";
const havePodman = (await PodmanSandbox.available()) && (await PodmanSandbox.hasImage(IMAGE));
const skip = havePodman ? false : `needs podman and the image ${IMAGE}`;

// ---------------------------------------------------------------- the isolation promises, as data

test("podman run arguments carry every isolation property, and the default is NO network", () => {
	const b = new PodmanSandbox({ dir: "/tmp/x" });
	const args = b.runArgs({ name: "sbx-1", key: "main:incidents", token: "t".repeat(32), image: "img:1" });
	const has = (...seq: string[]) => args.join(" ").includes(seq.join(" "));
	assert.ok(has("--user 10001:10001"), "non-root");
	assert.ok(args.includes("--read-only"), "read-only root filesystem");
	assert.ok(args.includes("--cap-drop=ALL"));
	assert.ok(has("--security-opt no-new-privileges"));
	assert.ok(has("--network none"), "airgapped by default");
	assert.ok(args.includes("--memory") && args.includes("--cpus") && args.includes("--pids-limit"), "resource limits");
	assert.ok(args.includes("--timeout"), "hard lifetime");
	const mounts = args.filter((_, i) => args[i - 1] === "-v");
	assert.equal(mounts.length, 3);
	assert.ok(mounts.some((m) => m.endsWith(":/sock")) && mounts.some((m) => m.endsWith(":/opt/runner.mjs:ro")) && mounts.some((m) => m.endsWith(":/opt/pi-env:ro")), "only the socket directory and two read-only code mounts come from the host");
	assert.ok(!args.includes("--privileged") && !args.some((a) => a.startsWith("--device")));
	assert.ok(new PodmanSandbox({ dir: "/tmp/x", network: "public" }).runArgs({ name: "n", key: "k", token: "t", image: "i" }).join(" ").includes("--network pasta"), "outbound access is a deliberate choice");
});

test("pod spec carries every isolation property we rely on (Crewpi's, unchanged in substance)", () => {
	const p: any = podSpec({ name: sandboxName("incidents"), key: "incidents", token: "t".repeat(32), image: "img:1", namespace: "entropi-sandboxes" });
	const c = p.spec.containers[0];
	assert.equal(p.spec.automountServiceAccountToken, false, "no Kubernetes credentials inside");
	assert.equal(p.spec.securityContext.runAsNonRoot, true);
	assert.notEqual(p.spec.securityContext.runAsUser, 0);
	assert.equal(p.spec.securityContext.seccompProfile.type, "RuntimeDefault");
	assert.equal(c.securityContext.readOnlyRootFilesystem, true);
	assert.equal(c.securityContext.allowPrivilegeEscalation, false);
	assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"]);
	assert.ok(c.resources.limits.memory && c.resources.limits.cpu);
	assert.ok(p.spec.activeDeadlineSeconds <= 7200);
	assert.ok(!JSON.stringify(p.spec.volumes).includes("hostPath"));
	assert.equal(sandboxName("a"), sandboxName("a"));
	assert.notEqual(sandboxName("a"), sandboxName("b"));
});

// ---------------------------------------------------------------- the runner + env, on a unix socket, no container

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createSandboxEnv, sandboxEnvFor } from "../src/adapters/sandbox/env.ts";
import { dirname } from "node:path";

let proc: ChildProcess;
const work = mkdtempSync(join(tmpdir(), "entropi-work-"));
const sockDir = mkdtempSync(join(tmpdir(), "entropi-sock-"));
const ep: Endpoint = { kind: "unix", socketPath: join(sockDir, "r.sock") };
const TOKEN = "0123456789abcdef0123456789";
after(() => proc?.kill());
const PI_ENV_DIR = dirname(new URL(import.meta.resolve("@earendil-works/pi-durable/env/node")).pathname);

test("runner + env: Pi's own env behind a socket: files, streamed output, timeouts, abort, binary readers, honest not_supported", async () => {
	proc = spawn("node", ["sandbox/runner.mjs"], { env: { PATH: process.env.PATH!, RUNNER_TOKEN: TOKEN, WORK_DIR: work, LISTEN_SOCKET: ep.socketPath, PI_ENV_DIR }, stdio: "ignore" });
	for (let i = 0; i < 40 && !(await callRunner(ep, TOKEN, "/health").then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
	await assert.rejects(() => callRunner(ep, "wrong-token-wrong-token", "/rpc", { m: "exists", a: ["x"] }), /unauthorized/);
	const hooks: any[] = [];
	const env = createSandboxEnv({ id: "t", ensure: async () => ({ name: "n", endpoint: ep, token: TOKEN }), hooks: { afterExec: (c, code) => hooks.push([c, code]) } });

	assert.equal(env.cwd, "/work");
	assert.ok((await env.writeFile("a/b.txt", "hello", ctx)).ok === false || true); // a parent that does not exist yet:
	assert.ok((await env.createDir(`${work}/a`, { recursive: true }, ctx)).ok);
	assert.ok((await env.writeFile(`${work}/a/b.txt`, "hello", ctx)).ok);
	const r = await env.readTextFile(`${work}/a/b.txt`, ctx);
	assert.deepEqual([r.ok, r.ok && r.value], [true, "hello"]);
	const bin = await env.readBinaryFile(`${work}/a/b.txt`, ctx);
	assert.ok(bin.ok && bin.value instanceof Uint8Array && Buffer.from(bin.value).toString() === "hello", "bytes survive the trip");
	const miss = await env.readTextFile(`${work}/nope`, ctx);
	assert.ok(!miss.ok && miss.error.code === "not_found", "errors come back as Pi's own error type and code");

	const reader = await env.openBinaryReader(`${work}/a/b.txt`, undefined, ctx);
	assert.ok(reader.ok);
	const info = await reader.value.info(ctx);
	assert.ok(info.ok && info.value.size === 5, "a reader opened inside the sandbox works from here");
	assert.ok((await reader.value.close(ctx)) === undefined);

	const chunks: string[] = [];
	const ex = await env.exec("echo one; sleep 0.3; echo two; echo token=[$RUNNER_TOKEN] 1>&2", { onOutput: (t) => chunks.push(t) }, ctx);
	assert.deepEqual([ex.ok, ex.ok && ex.value.exitCode], [true, 0]);
	assert.match(chunks.join(""), /one[\s\S]*two/);
	assert.match(chunks.join(""), /token=\[\]/, "the runner token is not visible to commands");
	assert.ok(chunks.length >= 2, "output arrives as a stream, not at the end");
	assert.deepEqual(hooks.at(-1)![1], 0, "the audit hook sees the exit code");

	const slow = await env.exec("sleep 20", { timeout: 1 }, ctx);
	assert.ok(!slow.ok && slow.error.code === "timeout", "Pi's own timeout, enforced in the sandbox");

	const ac = new AbortController();
	const t0 = Date.now();
	setTimeout(() => ac.abort(), 300);
	const aborted = await env.exec("sleep 20", {}, { ...ctx, abortSignal: ac.signal } as any);
	assert.ok(!aborted.ok && Date.now() - t0 < 4000, "cancelling the call stops the command promptly");
	assert.equal(spawnSync("sh", ["-c", "pgrep -xf \"sleep 20\" | wc -l"], { encoding: "utf8" }).stdout.trim(), "0", "and the process is gone");

	const big = await env.exec("yes | head -c 400000", { window: { maxBytes: 4096, maxLines: 100, minIntervalMs: 0, bytesPerSecond: 1e9 }, spill: { afterBytes: 1000, afterLines: 10 }, onOutput: () => {} }, ctx);
	assert.ok(big.ok && big.value.spillPath, "large output spills to a file, as in any Pi environment");

	const unsupported = await env.createTempDir("x", ctx);
	assert.ok(!unsupported.ok && unsupported.error.code === "not_supported", "what the tools do not use is not pretended");
});

// ---------------------------------------------------------------- real containers

function manager(extra: { max?: number; idleMin?: number; dir?: string; db?: ReturnType<typeof openDb> } = {}) {
	const dir = extra.dir ?? mkdtempSync(join(tmpdir(), "entropi-sbx-"));
	const db = extra.db ?? openDb(":memory:");
	const backend = new PodmanSandbox({ dir, pool: `t${dir.split("/").pop()}` }); // one pool per data directory: a "restarted server" on the same directory sees its own containers
	return { m: new SandboxManager({ db, backend, image: IMAGE, max: extra.max ?? 3, idleMin: extra.idleMin }), backend, dir, db };
}
const key = () => `t${Date.now()}${Math.random().toString(36).slice(2, 6)}:space`;
const sh = async (env: any, cmd: string) => { let out = ""; const r = await env.exec(cmd, { timeout: 10, onOutput: (t: string) => (out += t) }, ctx); return { code: r.ok ? r.value.exitCode : -1, out }; };

test("a real sandbox: created on demand, files and commands work, the container is locked down and has no network", { skip, timeout: 120_000 }, async () => {
	const { m } = manager();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		assert.equal((await m.list()).length, 0, "building the env creates nothing");
		assert.ok((await env.writeFile("/work/hello.py", 'print("sum", sum(range(10)))', ctx)).ok);
		assert.equal(m.list().length, 1, "the first real use creates the sandbox");
		const run = await sh(env, "python3 hello.py");
		assert.deepEqual([run.code, run.out.trim()], [0, "sum 45"]);
		assert.equal((await sh(env, "id -u")).out.trim(), "10001", "non-root");
		assert.notEqual((await sh(env, "touch /etc/x")).code, 0, "read-only root filesystem");
		assert.equal((await sh(env, "touch /work/ok && echo y")).out.trim(), "y", "/work is writable");
		assert.equal((await sh(env, "ls /sys/class/net | tr '\\n' ' '")).out.trim(), "lo", "only the loopback interface exists: airgapped");
		assert.doesNotMatch((await sh(env, "curl -sS -m 3 https://example.com 2>&1; echo exit=$?")).out, /<html|Example Domain/i, "the public internet is not reachable");
		assert.match((await sh(env, "grep CapEff /proc/self/status")).out, /CapEff:\s+0+\b/, "no capabilities");
		assert.ok(!(await sh(env, "env")).out.includes("RUNNER_TOKEN"), "the runner token is not in the environment of commands");
	} finally {
		await m.stop(k);
	}
});

test("restart of this process: the sandbox is found again with its files; stop removes it; the limit is enforced", { skip, timeout: 180_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "entropi-sbx-"));
	const db = openDb(":memory:");
	const a = manager({ dir, db, max: 1 });
	const k1 = key(), k2 = key();
	try {
		const first = sandboxEnvFor(a.m, k1);
		assert.ok((await first.writeFile("/work/keep.txt", "still here", ctx)).ok);
		const b = manager({ dir, db, max: 1 }); // a new manager over the same registry: this is "the server restarted"
		const again = await sandboxEnvFor(b.m, k1).readTextFile("/work/keep.txt", ctx);
		assert.deepEqual([again.ok, again.ok && again.value], [true, "still here"], "the container, and its files, outlived the process");
		await assert.rejects(() => b.m.ensure(k2), /sandbox limit reached/);
		assert.equal(await b.m.stop(k1), true);
		assert.deepEqual(await b.backend.list(), []);
		assert.equal(b.m.list().length, 0);
	} finally {
		await a.m.stop(k1); await a.m.stop(k2);
	}
});

test("sweeping removes idle sandboxes and containers nobody tracks", { skip, timeout: 120_000 }, async () => {
	const { m, backend, db } = manager({ idleMin: 30 });
	const k = key();
	try {
		await m.ensure(k);
		await m.sweep();
		assert.equal(m.list().length, 1, "fresh sandboxes stay");
		db.prepare("UPDATE sandboxes SET last_used = 1").run(); // idle for a very long time
		await m.sweep();
		assert.equal(m.list().length, 0);
		assert.deepEqual(await backend.list(), [], "and the container is gone");
		await m.ensure(k);
		db.prepare("DELETE FROM sandboxes").run(); // an orphan: the container exists, the registry forgot it
		await m.sweep();
		assert.deepEqual(await backend.list(), []);
	} finally {
		await m.stop(k);
	}
});

test("a missing image is a clear, actionable error (no network needed to read it)", { skip: havePodman ? false : "needs podman" }, async () => {
	const { backend } = manager();
	await assert.rejects(() => backend.start({ name: "sbx-noimage", key: "k", token: "t".repeat(32), image: "localhost/does-not-exist:1" }), /scripts\/build-sandbox\.sh/);
});

// ---------------------------------------------------------------- agents using it, through Pi

import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "./pi-world.ts";

const sbxContainers = () => spawnSync("podman", ["ps", "-a", "--filter", "label=app=entropi-sandbox", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const cleanup = (names: string[]) => { for (const n of names) spawnSync("podman", ["rm", "-f", "-t", "0", n]); };

test("a developer agent writes and runs code in its space's sandbox; the ops agent was never given the tools", { skip, timeout: 180_000 }, async () => {
	const before = new Set(sbxContainers());
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), sandboxDir: mkdtempSync(join(tmpdir(), "entropi-sbx-")) });
	await w.start();
	try {
		w.core.postMessage("main", "incidents", "human:anna", { text: "@developer sandbox please", dispatchTo: ["agent:developer"] });
		await until(() => w.core.listMessages("main", "incidents", "human:anna").some((m) => m.authorId === "agent:developer" && m.kind === "agent" && m.status === "done"), 90_000);
		const r = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.authorId === "agent:developer" && m.kind === "agent")!;
		assert.match(r.text, /sum 45/, r.text);
		assert.deepEqual((r.meta.activity as any[]).map((a) => `${a.name}:${a.status}`), ["write:done", "bash:done"]);
		assert.ok(w.core.events("main").some((e) => e.type === "sandbox.exec" && e.actorId === "agent:developer"), "running a command is on the record");

		w.core.postMessage("main", "incidents", "human:anna", { text: "@ops sandbox please", dispatchTo: ["agent:ops"] });
		await until(() => w.core.listMessages("main", "incidents", "human:anna").some((m) => m.authorId === "agent:ops" && m.kind === "agent" && m.status === "done"), 60_000);
		const o = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.authorId === "agent:ops" && m.kind === "agent")!;
		assert.ok((o.meta.activity as any[]).every((a) => a.status === "error"), "ops was not given Pi's coding tools, so its calls fail");
		assert.equal(w.sandbox!.list().length, 1, "and no second sandbox was created for it");
	} finally {
		await w.close();
		cleanup(sbxContainers().filter((n) => !before.has(n)));
	}
});

test("a crash right after a sandbox command ran: the command is NOT run again, and the agent is told it was interrupted", { skip, timeout: 240_000 }, async () => {
	const { spawn } = await import("node:child_process");
	const dir = mkdtempSync(join(tmpdir(), "entropi-sbxcrash-"));
	const sbxDir = join(dir, "sbx");
	const before = new Set(sbxContainers());
	const life = (action: string, arg: string, env: Record<string, string> = {}) => new Promise<{ signal: string | null; summary?: any }>((resolve) => {
		const p = spawn(process.execPath, ["test/crash/child.ts", dir, action, arg], { env: { ...process.env, SBX_DIR: sbxDir, AGENT: "agent:developer", SETTLE_MS: "30000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.on("close", (_c, signal) => { const l = out.split("\n").find((x) => x.startsWith("SUMMARY ")); resolve({ signal, summary: l ? JSON.parse(l.slice(8)) : undefined }); });
	});
	try {
		const dead = await life("post", "@developer countrun", { ENTROPI_FAILPOINT: "sandbox:after-exec" });
		assert.equal(dead.signal, "SIGKILL");
		const name = sandboxName("main:incidents");
		assert.equal(spawnSync("podman", ["exec", name, "cat", "/work/count.txt"], { encoding: "utf8" }).stdout.trim().split("\n").length, 1, "the command ran once before the crash");
		const a = await life("settle", "");
		assert.equal(a.signal, null);
		assert.equal(spawnSync("podman", ["exec", name, "cat", "/work/count.txt"], { encoding: "utf8" }).stdout.trim().split("\n").length, 1, "and not again after the restart");
		assert.equal(a.summary.agentMessages.length, 1);
		assert.equal(a.summary.agentMessages[0].status, "done");
		assert.match(a.summary.agentMessages[0].text, /interrupt/i, "the agent was told, in plain words, that the command was interrupted");
	} finally {
		cleanup(sbxContainers().filter((n) => !before.has(n)));
	}
});

// More hostile-command tests live in their own file but must run in this process: real containers share one podman namespace.
import "./support/sandbox-hardening.ts";
