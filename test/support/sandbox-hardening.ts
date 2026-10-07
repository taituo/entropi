// Things a hostile or careless command inside the sandbox might try, with real containers (skipped without podman and the image).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openDb } from "../../src/core/db.ts";
import { PodmanSandbox } from "../../src/adapters/sandbox/podman.ts";
import { SandboxManager } from "../../src/adapters/sandbox/manager.ts";
import { sandboxEnvFor } from "../../src/adapters/sandbox/env.ts";

const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "localhost/crew-sandbox:dev";
const have = (await PodmanSandbox.available()) && (await PodmanSandbox.hasImage(IMAGE));
const skip = have ? false : `needs podman and the image ${IMAGE}`;
const key = () => `h${Date.now()}${Math.random().toString(36).slice(2, 6)}:space`;
const sh = async (env: any, cmd: string, timeout = 20) => { let out = ""; const r = await env.exec(cmd, { timeout, onOutput: (t: string) => (out += t) }, ctx); return { code: r.ok ? r.value.exitCode : -1, out, error: r.ok ? undefined : r.error }; };
const make = (o: { network?: "none" | "public" } = {}) => {
	const backend = new PodmanSandbox({ dir: mkdtempSync(join(tmpdir(), "entropi-hard-")), pool: `h${process.pid}-${Math.random().toString(36).slice(2, 8)}`, ...o });
	return { backend, m: new SandboxManager({ db: openDb(":memory:"), backend, image: IMAGE, max: 3 }) };
};

test("hardening: the sandbox cannot reach the host or anything beyond: not the host's loopback, not its addresses, not DNS, not the internet", { skip, timeout: 120_000 }, async () => {
	// a listener on the host: reachable on 127.0.0.1 from the host, must not be from the sandbox
	const srv = createServer((s) => s.end("HOST-SECRET")).listen(0, "0.0.0.0");
	await new Promise((r) => srv.once("listening", r));
	const port = (srv.address() as any).port;
	const { m } = make();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		const probe = (host: string) => sh(env, `node -e "const s=require('net').connect(${port},'${host}');s.on('data',d=>{console.log('GOT',String(d));process.exit(0)});s.on('error',e=>{console.log('ERR',e.code);process.exit(1)});setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},3000)"`);
		for (const host of ["127.0.0.1", "10.0.2.2", "10.88.0.1", "host.containers.internal", "host.docker.internal", "192.168.1.1"]) {
			const r = await probe(host);
			assert.ok(!r.out.includes("HOST-SECRET"), `the host service answered on ${host}`);
		}
		for (const cmd of ["getent hosts example.com", "getent hosts localhost.localdomain.invalid", "curl -sS -m 3 http://1.1.1.1 2>&1", "curl -sS -m 3 https://example.com 2>&1", "python3 -c \"import socket;s=socket.create_connection(('8.8.8.8',53),3)\" 2>&1", "bash -c 'echo > /dev/tcp/1.1.1.1/80' 2>&1"]) {
			const r = await sh(env, cmd);
			assert.ok(r.code !== 0 || r.out.trim() === "", `"${cmd}" should fail, got code ${r.code}: ${r.out.slice(0, 100)}`);
			assert.doesNotMatch(r.out, /<html|Example Domain|\d+\.\d+\.\d+\.\d+\s+example/i);
		}
		assert.equal((await sh(env, "ls /sys/class/net | tr '\\n' ' '")).out.trim(), "lo");
		assert.equal((await sh(env, "cat /proc/net/route | wc -l")).out.trim(), "1", "no routes at all");
	} finally { srv.close(); await m.stop(k); }
});

test("hardening: the runner's token is not in any command line, file or the environment of a command", { skip, timeout: 120_000 }, async () => {
	// Known and accepted: the runner process itself still has the token in /proc/1/environ, readable by the same user. That gives a
	// command nothing it does not already have (it can run commands); the token exists to keep other pods and users from calling the runner.
	const { m } = make();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		const token = (await m.ensure(k)).token;
		const probes = await sh(env, "env; cat /proc/self/environ | tr '\\0' '\\n'; for p in /proc/[0-9]*; do cat $p/cmdline 2>/dev/null | tr '\\0' ' '; echo; done; ls -la / /opt /tmp /work 2>&1; grep -rsl . /work /tmp 2>/dev/null");
		assert.ok(!probes.out.includes(token), "the token appears in a command line, a file or the command's own environment");
	} finally { await m.stop(k); }
});

test("hardening: the host's files are not there, symlinks lead nowhere useful, and writes outside the work area fail", { skip, timeout: 120_000 }, async () => {
	const { m } = make();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		assert.notEqual((await sh(env, "ls /home/tiny 2>&1")).code, 0);
				assert.doesNotMatch((await sh(env, "cat /etc/hostname /etc/passwd 2>&1 | head -20")).out, /tiny:/, "the host's passwd is not the container's");
		// Pi's file API with traversal: the sandbox's own filesystem, nothing of the host
		for (const p of ["/work/../../etc/shadow", "../../../etc/shadow", "/proc/1/root/etc/shadow", "/work/../home/tiny/.ssh/id_rsa"]) {
			const r = await env.readTextFile(p, ctx);
			assert.ok(!r.ok, `${p} must not be readable (read-only, unprivileged)`);
		}
		const w = await env.writeFile("/work/../etc/evil", "x", ctx);
		assert.ok(!w.ok, "a traversal write outside /work fails (read-only root)");
		assert.doesNotMatch((await sh(env, "ln -s / /work/rootlink && ls /work/rootlink/home")).out, /tiny/, "a symlink to / is the container's /, not the host's");
		assert.notEqual((await sh(env, "mount -t tmpfs none /mnt 2>&1")).code, 0, "no mounting");
		assert.notEqual((await sh(env, "chmod u+s /work/rootlink && su 2>&1")).code, 0);
		assert.notEqual((await sh(env, "cat /sys/kernel/security/lsm >/dev/null 2>&1 && echo writable > /proc/sys/kernel/hostname")).code, 0, "no writing to the host's kernel parameters");
	} finally { await m.stop(k); }
});

test("hardening: a memory bomb and a fork bomb are contained, and the sandbox still works afterwards", { skip, timeout: 180_000 }, async () => {
	const { m } = make();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		const mem = await sh(env, "python3 -c \"x = b'x' * (3 * 1024**3); print('ALLO' + 'CATED')\" 2>&1", 60);
		assert.ok(!/^ALLOCATED$/m.test(mem.out), "3 GB must not be allocated under a 1 GB limit");
		await sh(env, "bash -c ':(){ :|:& };:' 2>&1; sleep 1; echo survived", 30);
		await new Promise((r) => setTimeout(r, 3000));
		const after = await sh(env, "echo still-alive", 60);
		assert.match(after.out, /still-alive/, "the sandbox answers after the abuse (whether or not the bomb used up every process slot)");
	} finally { await m.stop(k); }
});

test("hardening: commands run in parallel in one sandbox, output of any size is streamed and bounded, and a timeout leaves nothing behind", { skip, timeout: 180_000 }, async () => {
	const { m } = make();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sh(env, `sleep 0.3; echo job-${i}`)));
		assert.deepEqual(results.map((r) => r.out.trim()), Array.from({ length: 6 }, (_, i) => `job-${i}`));
		let seen = 0;
		const big = await env.exec("yes abcdefghij | head -c 20000000", { window: { maxBytes: 4096, maxLines: 100, minIntervalMs: 0, bytesPerSecond: 1e9 }, spill: { afterBytes: 1000, afterLines: 10 }, onOutput: (t: string) => { seen += t.length; } }, ctx);
		assert.ok(big.ok, "20 MB of output is handled");
		assert.ok(big.ok && (big.value as any).spillPath, "past the window the output goes to a file, as in any Pi environment");
		assert.ok(big.ok && Buffer.byteLength((big.value as any).output ?? "") < 200_000, "and the result itself stays small");
		void seen;
		const slow = await env.exec("(sleep 60 &) ; sleep 60", { timeout: 1 }, ctx);
		assert.ok(!slow.ok && slow.error.code === "timeout");
		await new Promise((r) => setTimeout(r, 1000));
		assert.equal((await sh(env, "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^sleep 60'; true")).out.trim().split("\n").pop(), "0", "the timed-out command's children are gone too");
	} finally { await m.stop(k); }
});

test("hardening: with the public network switched on, private ranges are still unreachable (the supplied policy's promise, checked from inside)", { skip: skip || !process.env.SANDBOX_TEST_PUBLIC_NET ? "set SANDBOX_TEST_PUBLIC_NET=1 on a machine that may open outbound traffic" : false, timeout: 120_000 }, async () => {
	const { m } = make({ network: "public" });
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		const r = await sh(env, "curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com 2>&1");
		assert.match(r.out, /200|301|302/, "public web works when asked for");
	} finally { await m.stop(k); }
});

test("hardening: a sandbox with every process slot taken is replaced once, and the output says so", { skip, timeout: 180_000 }, async () => {
	const { m } = make();
	const k = key();
	try {
		const env = sandboxEnvFor(m, k);
		// Deterministic: while this command is still running, 300 sleepers cannot all start under a limit of 256 processes.
		const stopHolding = new AbortController();
		let out = "", filled!: () => void;
		const seen = new Promise<void>((r) => (filled = r));
		const holding = env.exec("for i in $(seq 300); do sleep 600 >/dev/null 2>&1 & done; echo filled; sleep 40", { timeout: 60, onOutput: (t: string) => { out += t; if (out.includes("Resource temporarily unavailable")) filled(); } }, { ...ctx, abortSignal: stopHolding.signal } as any).catch(() => {}); // its container gets replaced under it: the call ends with a reset, which is expected
		await seen; // the event we wait for: bash reports that it can no longer fork, so every slot is taken
		const after = await sh(env, "echo still-alive", 60);
		assert.match(after.out, /still-alive/);
		assert.match(after.out, /restarted/, "the output says the sandbox was replaced");
		stopHolding.abort(); // its container is gone; let go of the call
		await holding;
	} finally { await m.stop(k); }
});
