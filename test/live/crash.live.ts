// SIGKILL a process that is talking to a REAL model, restart it on the same files, and check that the state converges.
// Wording differs from run to run (the model is not deterministic); the facts must not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
function life(dir: string, action: string, arg = "", env: Record<string, string> = {}): Promise<{ signal: string | null; summary?: any; err: string }> {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, ["test/crash/child.ts", dir, action, arg], { env: { ...process.env, LIVE: "1", SETTLE_MS: "90000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (_c, signal) => {
			const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
			resolve({ signal, summary: line ? JSON.parse(line.slice(8)) : undefined, err: err.replace(/Bearer\s+\S+/g, "Bearer ***") });
		});
	});
}
const tmp = () => mkdtempSync(join(tmpdir(), "entropi-livecrash-"));
const done = (s: any) => s.agentMessages.filter((m: any) => m.status === "done");

test("2a. killed in the middle of streaming an answer: one finished answer after restart", { skip: !live, timeout: 300_000 }, async () => {
	const dir = tmp();
	const dead = await life(dir, "post", "@ops explain in four sentences why database connection pools matter for a web service", { ENTROPI_FAILPOINT: "stream:mid" });
	assert.equal(dead.signal, "SIGKILL", `the process must die mid-stream (stderr: ${dead.err.slice(0, 300)})`);
	const a = await life(dir, "settle");
	assert.equal(a.signal, null, a.err.slice(0, 300));
	obs("2a answer after restart", done(a.summary)[0]?.text?.slice(0, 200));
	assert.equal(done(a.summary).length, 1);
	assert.equal(a.summary.agentMessages.length, 1, "exactly one agent message");
	assert.ok(done(a.summary)[0].text.length > 40, "a real, complete answer");
	assert.equal(a.summary.piConversations, 1);
	assert.equal(a.summary.piAssistantEntries, 1, "the half-written answer left no second assistant entry");
	assert.deepEqual(a.summary.outbox, ["sent"]);
});

test("2b. killed while the agent waits for approval: same decision, one card, the verdict still reaches the model", { skip: !live, timeout: 400_000 }, async () => {
	const dir = tmp();
	const dead = await life(dir, "post", "@ops restart the deployment checkout-api in production. That changes a live system: get a human approval first, then report the verdict in one sentence.", { ENTROPI_FAILPOINT: "tool:after-decision" });
	assert.equal(dead.signal, "SIGKILL", `must die after the decision was opened (stderr: ${dead.err.slice(0, 300)})`);
	const waiting = await life(dir, "settle");
	obs("2b after restart (waiting)", { decisions: waiting.summary.decisions, cards: waiting.summary.cards, works: waiting.summary.works, status: waiting.summary.agentMessages.map((m: any) => m.status) });
	assert.equal(waiting.summary.decisions, 1, "the rerun of the tool found the same decision");
	assert.equal(waiting.summary.cards, 1);
	assert.deepEqual(waiting.summary.agentMessages.map((m: any) => m.status), ["working"]);
	const decided = await life(dir, "decide", "approve");
	assert.equal(decided.signal, null, decided.err.slice(0, 300));
	obs("2b final answer", done(decided.summary)[0]?.text);
	assert.equal(decided.summary.decisions, 1);
	assert.equal(decided.summary.cards, 1);
	assert.equal(decided.summary.piConversations, 1);
	assert.equal(done(decided.summary).length, 1);
	assert.match(done(decided.summary)[0].text, /approv/i);
});

test("2c. killed right after Pi accepted the message: redelivery does not make the model answer twice", { skip: !live, timeout: 300_000 }, async () => {
	const dir = tmp();
	const dead = await life(dir, "post", "@ops what is 12 * 12? Reply with just the number.", { ENTROPI_FAILPOINT: "dispatch:after-submit" });
	assert.equal(dead.signal, "SIGKILL", dead.err.slice(0, 300));
	const a = await life(dir, "settle");
	obs("2c answer", done(a.summary)[0]?.text);
	assert.match(done(a.summary)[0].text, /144/);
	assert.equal(a.summary.agentMessages.length, 1);
	assert.equal(a.summary.piAssistantEntries, 1);
	assert.deepEqual(a.summary.outbox, ["sent"]);
});
