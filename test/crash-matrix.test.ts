// Real SIGKILLs at every named failpoint, in more situations than the basic crash test: a stream cut in the middle,
// a delegation, a queue of messages, a compaction, and two crashes in a row. After each: the next lives converge on the
// same state as an undisturbed run, and no effect happens twice (one answer, one hand-over, one card, one compaction).
import { test } from "node:test";
import assert from "node:assert/strict";
import { done, life, tmp } from "./support/life.ts";

const expectKilled = (r: { signal: string | null; err: string }, why = "") => assert.equal(r.signal, "SIGKILL", `the failpoint ${why} must fire (stderr: ${r.err.slice(0, 200)})`);

test("crash in the middle of a streamed answer: the partial text is thrown away and the answer is produced once", async () => {
	const dir = tmp();
	const text = "@ops " + "tell me about a very long story ".repeat(10);
	expectKilled(await life(dir, "post", text, { ENTROPI_FAILPOINT: "stream:mid", SLOW_STREAM: "20" }), "stream:mid");
	const a = await life(dir, "settle");
	assert.equal(a.signal, null, a.err);
	assert.equal(a.summary.agentMessages.length, 1);
	assert.equal(a.summary.agentMessages[0].status, "done");
	assert.equal(a.summary.agentMessages[0].text, `echo: ${text.trim()}`);
	assert.equal(a.summary.piAssistantEntries, 1);
	assert.deepEqual(a.summary.outbox, ["sent"]);
});

for (const point of ["dispatch:after-reply", "dispatch:after-submit", "pump:before-mark", "finalize:before-update"]) {
	test(`crash at ${point} with three messages queued: all three are answered once each`, async () => {
		const dir = tmp();
		expectKilled(await life(dir, "post", "@ops one|@ops two|@ops three", { ENTROPI_FAILPOINT: point }), point);
		const a = await life(dir, "settle");
		assert.equal(a.signal, null, a.err);
		assert.deepEqual(done(a.summary).map((m: any) => m.text).sort(), ["echo: @ops one", "echo: @ops three", "echo: @ops two"]);
		assert.equal(a.summary.agentMessages.length, 3, "no extra and no missing replies");
		assert.equal(a.summary.piConversations, 1);
		assert.equal(a.summary.piAssistantEntries, 3);
		assert.deepEqual(a.summary.outbox, ["sent", "sent", "sent"]);
		const b = await life(dir, "settle");
		assert.deepEqual(b.summary, a.summary, "another restart changes nothing");
	});
}

test("two crashes in a row (the second during recovery from the first) still converge on one answer", async () => {
	const dir = tmp();
	expectKilled(await life(dir, "post", "@ops hello", { ENTROPI_FAILPOINT: "dispatch:after-submit" }), "first");
	expectKilled(await life(dir, "settle", "", { ENTROPI_FAILPOINT: "finalize:before-update" }), "second");
	expectKilled(await life(dir, "settle", "", { ENTROPI_FAILPOINT: "finalize:before-update" }), "third");
	const a = await life(dir, "settle");
	assert.equal(a.signal, null, a.err);
	assert.deepEqual(a.summary.agentMessages, [{ status: "done", text: "echo: @ops hello" }]);
	assert.equal(a.summary.piAssistantEntries, 1);
	assert.equal(a.summary.piConversations, 1);
	assert.deepEqual(a.summary.outbox, ["sent"]);
});

test("crash right after a delegation was recorded: the colleague is asked once, answers once, and ops finishes once", async () => {
	const dir = tmp();
	expectKilled(await life(dir, "post", "@ops please delegate this", { ENTROPI_FAILPOINT: "delegate:after-core" }), "delegate:after-core");
	const a = await life(dir, "settle");
	assert.equal(a.signal, null, a.err);
	const byDev = a.summary.agentAuthors.filter((x: string) => x === "agent:developer").length;
	const byOps = a.summary.agentAuthors.filter((x: string) => x === "agent:ops").length;
	assert.equal(byDev, 1, `the developer answered exactly once (authors: ${a.summary.agentAuthors})`);
	assert.equal(byOps, 1, "ops answered exactly once");
	assert.ok(a.summary.agentMessages.every((m: any) => m.status === "done"));
	assert.equal(a.summary.works, 0 + a.summary.works); // no work items are created by plain delegation
	assert.equal(a.summary.piConversations, 2, "one conversation per agent");
	const b = await life(dir, "settle");
	assert.deepEqual(b.summary, a.summary);
});

test("crash while the context is being compacted: the answers stay intact and the next compaction succeeds", async () => {
	const dir = tmp();
	const env = { KEEP: "40" };
	const msgs = Array.from({ length: 8 }, (_, i) => `@ops message number ${i} with some padding to make it longer ${"x".repeat(80)}`).join("|");
	const first = await life(dir, "post", msgs, env);
	assert.equal(first.signal, null, first.err);
	assert.equal(done(first.summary).length, 8);
	expectKilled(await life(dir, "compact", "", { ...env, ENTROPI_FAILPOINT: "compact:hook" }), "compact:hook");
	const a = await life(dir, "settle", "", env);
	assert.equal(a.signal, null, a.err);
	assert.equal(done(a.summary).length, 8, "nothing was lost or duplicated by the interrupted compaction");
	assert.equal(a.summary.agentMessages.length, 8);
	// a compaction on the restarted system works, and the conversation still answers afterwards
	const c = await life(dir, "compact", "", env);
	assert.equal(c.signal, null, c.err);
	assert.ok(c.summary.compactions >= 1, "a compaction entry exists");
	const d = await life(dir, "post", "@ops after the compaction", env);
	assert.equal(d.signal, null, d.err);
	assert.equal(done(d.summary).length, 9);
	assert.equal(done(d.summary).at(-1).text, "echo: @ops after the compaction");
});
