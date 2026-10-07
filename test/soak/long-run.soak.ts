// Soak 2: one agent on a genuinely long run (slow-streamed big answers, real sandbox
// tool rounds when podman has an image). Mid-run: stop, steer, and a queued message.
// The state must converge after every intervention. Runs SOAK_LONG_RUN_MINUTES (def 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PodmanSandbox } from "../../src/adapters/sandbox/podman.ts";
import { makeWorld, until } from "../pi-world.ts";
import { obs, tmpDir, soakMinutes, resolveSandboxImage, msgs, agentMsgs, longText } from "./support.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const MINUTES = soakMinutes("SOAK_LONG_RUN_MINUTES", 10);
const BIG = () => longText(100_000, Math.floor(Math.random() * 1e9));

async function converged(w: any, ms: number, what: string) {
	await until(() => w.core.trusted.workingMessages().length === 0 && w.core.trusted.pendingOutbox().length === 0, ms);
	const working = agentMsgs(w.core).filter((m: any) => m.status === "working");
	assert.equal(working.length, 0, `${what}: no agent left working`);
	assert.equal(w.core.trusted.pendingOutbox().length, 0, `${what}: outbox empty`);
}

async function quiet(w: any, ms: number, what: string) {
	const snap = () => JSON.stringify(msgs(w.core).map((m: any) => [m.id, m.status, (m.text ?? "").length]));
	const s0 = snap();
	await new Promise((r) => setTimeout(r, ms));
	assert.equal(snap(), s0, `${what}: nothing moved during the quiet period`);
}

test("soak-2 (scripted): 10-minute long run with stop, steer and queued messages converging", { timeout: 1_200_000 }, async () => {
	const t0 = Date.now();
	const end = t0 + MINUTES * 60_000;
	const image = resolveSandboxImage();
	const sandboxOk = image !== "" && await PodmanSandbox.available().catch(() => false) && await PodmanSandbox.hasImage(image).catch(() => false);
	if (image) process.env.SANDBOX_TEST_IMAGE = image;
	process.env.SLOW_STREAM = process.env.SLOW_STREAM ?? "300";
	const sbxDir = sandboxOk ? mkdtempSync(join(tmpdir(), "entropi-soak-sbx-")) : undefined;
	obs("soak-2 setup", { minutes: MINUTES, slowStream: process.env.SLOW_STREAM, sandbox: sandboxOk ? image : "(none: echo tasks)" });
	const w = await makeWorld({ dbPath: join(tmpDir("entropi-soak-2-"), "core.sqlite"), storage: new MemoryStorage(), ...(sbxDir ? { sandboxDir: sbxDir } : {}) });
	await w.start();
	const agents = () => agentMsgs(w.core);
	const post = (text: string, meta: any = {}) => w.core.postMessage("main", "incidents", "human:anna", { text: `@developer ${text}`, dispatchTo: ["agent:developer"], meta });
	const streaming = () => agents().filter((m: any) => m.status === "working" && (m.text ?? "").length > 20000);
	let cycles = 0;
	let stops = 0, steers = 0, queued = 0;
	try {
		if (sandboxOk) {
			post("sandbox: write hello.py and run it, then report");
			await converged(w, 300_000, "sandbox baseline");
			obs("soak-2 sandbox baseline ok", agents().map((m: any) => `${m.status}:${(m.text ?? "").slice(0, 60)}`));
		}
		while (Date.now() < end) {
			cycles++;
			const mode = cycles % 3;
			if (mode === 1) {
				post(`long task ${cycles}: ${BIG()}`);
				await until(() => streaming().length > 0, 300_000);
				const r = await w.runtime.stop({ realmId: "main", spaceId: "incidents", agentId: "agent:developer", by: "human:anna" });
				stops++;
				obs("soak-2 stop", { cycle: cycles, stopped: r.stopped });
				assert.ok(r.stopped >= 1, "stop ended the running work");
				await converged(w, 60_000, `stop cycle ${cycles}`);
				await quiet(w, 10_000, `stop cycle ${cycles}`);
			} else if (mode === 2) {
				const marker = `STEER-${cycles}-${Date.now() % 100000}`;
				post(`long task ${cycles}: ${BIG()}`);
				await until(() => streaming().length > 0, 300_000);
				post(marker, { steer: true });
				steers++;
				await converged(w, 600_000, `steer cycle ${cycles}`);
				const texts = agents().map((m: any) => m.text ?? "").join("\n");
				assert.ok(texts.includes(marker) || /Answered together/.test(texts), "the steered message was answered");
				obs("soak-2 steer ok", { cycle: cycles, marker });
			} else {
				const m1 = `QUEUE-${cycles}-a`, m2 = `QUEUE-${cycles}-b`;
				post(`${m1}: ${BIG()}`);
				post(`${m2}: reply with just the word ok`);
				queued += 2;
				await converged(w, 600_000, `queue cycle ${cycles}`);
				const texts = agents().map((m: any) => m.text ?? "").join("\n");
				assert.ok(texts.includes(m2), "the queued message was answered");
				obs("soak-2 queue ok", { cycle: cycles });
			}
		}
	} finally {
		if (sandboxOk) {
			const before = spawnSync("podman", ["ps", "-a", "--filter", "label=app=entropi-sandbox", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout;
			await w.close();
			const after = before.split("\n").filter(Boolean);
			const now = spawnSync("podman", ["ps", "-a", "--filter", "label=app=entropi-sandbox", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
			for (const n of now.filter((x) => !after.includes(x))) spawnSync("podman", ["rm", "-f", "-t", "0", n]);
		} else {
			await w.close();
		}
		delete process.env.SLOW_STREAM;
	}
	obs("soak-2 done", { minutes: Math.round((Date.now() - t0) / 60000), cycles, stops, steers, queued });
	assert.ok(Date.now() - t0 >= MINUTES * 60_000, "ran the full duration");
});

test("soak-2b (live): long delegation with stop, steer and a new message, then convergence", { skip: !live, timeout: 1_200_000 }, async () => {
	const w = await makeWorld({ dbPath: join(tmpDir("entropi-soak-2b-"), "core.sqlite"), storage: new MemoryStorage() });
	await w.start();
	try {
		const all = () => agentMsgs(w.core);
		w.core.postMessage("main", "incidents", "human:anna", {
			text: "@ops Use ask_agent to have @developer write a very long, detailed essay (at least 2500 words) on the history of TCP congestion control. Wait for it, then have @reviewer critique it in detail.",
			dispatchTo: ["agent:ops"],
		});
		await until(() => all().some((m: any) => m.authorId !== "agent:ops" && m.status === "working" && m.text.length > 200), 400_000);
		obs("soak-2b chain running", all().map((m: any) => `${m.authorId.slice(6)}:${m.status}:${m.text.length}`));
		const r = await w.runtime.stop({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" });
		obs("soak-2b stop", { stopped: r.stopped });
		await converged(w, 60_000, "live stop");
		w.core.postMessage("main", "incidents", "human:anna", { text: "@ops start over with a short essay (200 words) on UDP instead.", dispatchTo: ["agent:ops"], meta: { steer: true } });
		w.core.postMessage("main", "incidents", "human:anna", { text: "@ops also tell me one TCP fact in a sentence.", dispatchTo: ["agent:ops"] });
		await converged(w, 600_000, "live steer+queue");
		const texts = all().map((m: any) => m.text ?? "").join("\n");
		assert.ok(/UDP/i.test(texts), "the steered rerun answered");
		obs("soak-2b done", all().map((m: any) => `${m.authorId.slice(6)}:${m.status}:${m.text.length}`));
	} finally {
		await w.close();
	}
});
