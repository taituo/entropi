import { test } from "node:test";
import assert from "node:assert/strict";
import { life, tmp, done } from "./support/life.ts";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { Core } from "../src/core/core.ts";

/**
 * Real crashes: each "life" is a separate process on the same two database files (core.sqlite and pi.sqlite). A failpoint
 * makes it SIGKILL itself at one exact moment; the next process opens the same files and must converge on the same
 * result as if nothing had happened, with no duplicated message, card, work item, Pi answer or conversation.
 */

test("sanity: without a crash the loop completes once", async () => {
	const dir = tmp();
	const a = await life(dir, "post", "@ops hello");
	assert.equal(a.signal, null, a.err);
	assert.deepEqual(a.summary.agentMessages, [{ status: "done", text: "echo: @ops hello" }]);
	assert.equal(a.summary.piConversations, 1);
	assert.equal(a.summary.piAssistantEntries, 1);
	assert.deepEqual(a.summary.outbox, ["sent"]);
});

for (const point of ["dispatch:after-reply", "dispatch:after-submit", "pump:before-mark", "finalize:before-update"]) {
	test(`crash at ${point}: the restart converges on exactly one answer`, async () => {
		const dir = tmp();
		const dead = await life(dir, "post", "@ops hello", { ENTROPI_FAILPOINT: point });
		assert.equal(dead.signal, "SIGKILL", `the failpoint must fire (stderr: ${dead.err.slice(0, 200)})`);
		const a = await life(dir, "settle");
		assert.equal(a.signal, null, a.err);
		assert.deepEqual(a.summary.agentMessages, [{ status: "done", text: "echo: @ops hello" }], "one reply, finished");
		assert.equal(a.summary.piConversations, 1, "one conversation for (realm, space, agent)");
		assert.equal(a.summary.piAssistantEntries, 1, "Pi answered once: the requestId deduplicated the redelivery");
		assert.deepEqual(a.summary.outbox, ["sent"]);
		// and a third life changes nothing
		const b = await life(dir, "settle");
		assert.deepEqual(b.summary, a.summary);
	});
}

test("crash while a tool waits for approval: the rerun finds the same decision, one card, and the verdict still reaches the agent", async () => {
	const dir = tmp();
	const dead = await life(dir, "post", "@ops please approve the fix", { ENTROPI_FAILPOINT: "tool:after-decision" });
	assert.equal(dead.signal, "SIGKILL", dead.err);
	const waiting = await life(dir, "settle"); // restart: the safe tool replays and waits again
	assert.equal(waiting.summary.decisions, 1);
	assert.equal(waiting.summary.cards, 1);
	assert.equal(waiting.summary.works, 1);
	assert.deepEqual(waiting.summary.agentMessages.map((m: any) => m.status), ["working"]);

	const decided = await life(dir, "decide", "approve");
	assert.equal(decided.signal, null, decided.err);
	assert.equal(decided.summary.decisions, 1, "no second decision after the replay");
	assert.equal(decided.summary.cards, 1);
	assert.equal(decided.summary.piConversations, 1);
	assert.equal(done(decided.summary).length, 1);
	assert.match(done(decided.summary)[0].text, /APPROVED by Anna \(ok\)/);
	assert.equal(decided.summary.piAssistantEntries, 2, "one tool-call turn, one final answer");
});

test("a person decides while the runtime is down: the next start continues with the verdict", async () => {
	const dir = tmp();
	const dead = await life(dir, "post", "@ops approve this", { ENTROPI_FAILPOINT: "tool:after-decision" });
	assert.equal(dead.signal, "SIGKILL", dead.err);
	// No Pi process at all: only the core (e.g. the web server) is up and Anna clicks Approve.
	const core = new Core(openDb(join(dir, "core.sqlite")));
	const d = core.openDecisions("main")[0];
	core.decide("main", d.id, "human:anna", "approve", "while you were down");
	const a = await life(dir, "settle");
	assert.equal(done(a.summary).length, 1, a.err);
	assert.match(done(a.summary)[0].text, /APPROVED by Anna \(while you were down\)/);
	assert.equal(a.summary.decisions, 1);
	assert.equal(a.summary.piAssistantEntries, 2);
});

test("two simultaneous messages to one agent create one conversation, and both get answered after a crash in between", async () => {
	const dir = tmp();
	const dead = await life(dir, "post", "@ops first", { ENTROPI_FAILPOINT: "dispatch:after-submit" });
	assert.equal(dead.signal, "SIGKILL");
	const core = new Core(openDb(join(dir, "core.sqlite")));
	core.postMessage("main", "incidents", "human:anna", { text: "@ops second", dispatchTo: ["agent:ops"] });
	const a = await life(dir, "settle");
	assert.deepEqual(done(a.summary).map((m: any) => m.text).sort(), ["echo: @ops first", "echo: @ops second"]);
	assert.equal(a.summary.piConversations, 1);
	assert.equal(a.summary.piAssistantEntries, 2);
});
