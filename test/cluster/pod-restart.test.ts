// Against a real deployment (ENTROPI_URL, kubectl, a real model behind it): the pod is killed in the middle of work.
// The work continues or is reported, never done twice, and a pending approval survives. Run by `npm run test:cluster`.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dmOf, target, type Target } from "../support/target.ts";

const NS = process.env.ENTROPI_NAMESPACE ?? "entropi";
let t: Target; let dm: string;
const enabled = !!process.env.ENTROPI_URL;
const skip = enabled ? false : "set ENTROPI_URL (see scripts/test-cluster.sh)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> => {
	const t0 = Date.now();
	for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(1500); }
};
const kubectl = (...a: string[]) => spawnSync("kubectl", a, { encoding: "utf8" });
const killPod = () => { const r = kubectl("-n", NS, "delete", "pod", "-l", "app=entropi", "--wait=false"); assert.equal(r.status, 0, r.stderr); };
const agentMsgs = async (space: string) => (await t.call(t.users.operator!, "GET", `/spaces/${space}/messages`)).body.messages.filter((m: any) => m.kind === "agent");

before(async () => { if (enabled) { t = await target(); dm = await dmOf(t, t.users.operator!, "developer"); } });

test("pod restart in the middle of a long answer: one message, finished, not duplicated", { skip, timeout: 420_000 }, async () => {
	const base = new Set((await agentMsgs(dm)).map((m: any) => m.id));
	const post = await t.call(t.users.operator!, "POST", `/spaces/${dm}/messages`, { text: "Write a very long essay, at least 2500 words, with ten sections, on the history of TCP congestion control. Write it out in full." });
	assert.equal(post.status, 200);
	const reply = await until(async () => (await agentMsgs(dm)).find((m: any) => !base.has(m.id) && m.status === "working" && m.text.length > 400), 90_000, "the answer to start streaming");
	const before = reply.text.length;
	killPod();
	const finished = await until(async () => {
		const m = (await agentMsgs(dm)).find((x: any) => x.id === reply.id);
		return m && m.status === "done" ? m : undefined;
	}, 300_000, "the same message to finish after the restart");
	assert.ok(finished.text.length > 1000, `the answer was completed (${finished.text.length} chars, ${before} before the kill)`);
	await sleep(15_000);
	const mine = (await agentMsgs(dm)).filter((m: any) => !base.has(m.id));
	assert.equal(mine.length, 1, `exactly one answer for the one question, got ${mine.length}`);
	assert.equal(mine[0].status, "done");
	const dup = (await t.call(t.users.operator!, "GET", `/spaces/${dm}/messages`)).body.messages.filter((m: any) => m.kind === "chat").length;
	assert.ok(dup >= 1);
});

test("pod restart while an approval is pending: still one card, the verdict still reaches the agent", { skip, timeout: 420_000 }, async () => {
	const space = "incidents";
	const beforeIds = new Set((await t.call(t.users.approver!, "GET", "/decisions")).body.decisions.map((d: any) => d.id));
	const marker = `restart-${Date.now().toString(36)}`;
	await t.call(t.users.operator!, "POST", `/spaces/${space}/messages`, { text: `@ops Call the request_approval tool exactly once with action "${marker}", target "test", reason "restart test". After the verdict, say the word DONE and the verdict.` });
	const card = await until(async () => (await t.call(t.users.approver!, "GET", "/decisions")).body.decisions.find((d: any) => !beforeIds.has(d.id) && JSON.stringify(d).includes(marker)), 120_000, "the approval card");
	killPod();
	await sleep(3000);
	const after = await until(async () => {
		const ds = (await t.call(t.users.approver!, "GET", "/decisions")).body.decisions.filter((d: any) => JSON.stringify(d).includes(marker));
		return ds.length ? ds : undefined;
	}, 120_000, "the card after the restart");
	assert.equal(after.length, 1, "still exactly one open card with that marker");
	assert.equal(after[0].id, card.id, "the same decision");
	await sleep(20_000); // the agent's run was replayed: it must not have asked a second time
	assert.equal((await t.call(t.users.approver!, "GET", "/decisions")).body.decisions.filter((d: any) => JSON.stringify(d).includes(marker)).length, 1, "the replay did not ask again");
	assert.equal((await t.call(t.users.approver!, "POST", `/decisions/${card.id}/decide`, { answer: "approve", note: "after restart" })).status, 200);
	const fin = await until(async () => {
		const ms = (await agentMsgs(space)).filter((m: any) => /DONE/.test(m.text) && m.status === "done" && m.createdAt >= card.createdAt);
		return ms.length ? ms : undefined;
	}, 180_000, "the agent to finish with the verdict");
	assert.ok(fin.length >= 1);
});
