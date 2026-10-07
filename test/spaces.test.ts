import { test } from "node:test";
import assert from "node:assert/strict";
import { seededRealm } from "./helpers.ts";
import { CoreError } from "../src/core/errors.ts";

const code = (fn: () => unknown) => {
	try { fn(); } catch (e) { return e instanceof CoreError ? e.code : `other:${(e as Error).message}`; }
	return "none";
};

function world() {
	const t = seededRealm();
	const { core } = t;
	core.addActor("payments", { id: "agent:dev", kind: "agent", name: "Developer" }, "system");
	core.addActor("payments", { id: "agent:rev", kind: "agent", name: "Reviewer" }, "system");
	core.addActor("payments", { id: "human:vera", kind: "human", name: "Vera", roles: ["viewer"] }, "system");
	core.createSpace("payments", { id: "general", kind: "standing", name: "general", agentIds: ["agent:ops", "agent:dev", "agent:rev"] }, "system");
	return t;
}

test("spaces are idempotent; only agents can be members; DMs need a human owner and exactly one agent", () => {
	const { core } = world();
	assert.equal(core.createSpace("payments", { id: "general", kind: "standing", name: "other" }, "system").created, false);
	assert.equal(code(() => core.createSpace("payments", { kind: "standing", name: "x1", agentIds: ["human:anna"] }, "system")), "invalid");
	assert.equal(code(() => core.createSpace("payments", { id: "dm-a", kind: "dm", name: "Ops", ownerId: "agent:ops", agentIds: ["agent:ops"] }, "system")), "invalid");
	assert.equal(code(() => core.createSpace("payments", { id: "dm-b", kind: "dm", name: "Ops", ownerId: "human:anna", agentIds: ["agent:ops", "agent:dev"] }, "system")), "invalid");
});

test("a DM is invisible to everyone but its owner, in lists, messages and the event stream", () => {
	const { core } = world();
	core.createSpace("payments", { id: "dm-ops-anna", kind: "dm", name: "Ops", ownerId: "human:anna", agentIds: ["agent:ops"] }, "system");
	core.postMessage("payments", "dm-ops-anna", "human:anna", { text: "secret" });
	assert.deepEqual(core.listSpaces("payments", "human:anna").map((s) => s.id), ["general", "dm-ops-anna"]);
	assert.deepEqual(core.listSpaces("payments", "human:mikko").map((s) => s.id), ["general"]);
	assert.equal(core.canSee("payments", "human:mikko", "dm-ops-anna"), false);
	assert.equal(code(() => core.listMessages("payments", "dm-ops-anna", "human:mikko")), "not_found");
	assert.equal(code(() => core.postMessage("payments", "dm-ops-anna", "human:mikko", { text: "hi" })), "not_found");
	const secret = core.events("payments").filter((e) => e.data.spaceId === "dm-ops-anna");
	assert.ok(secret.length >= 2);
	assert.ok(secret.every((e) => core.canSeeEvent(e, "human:anna") && !core.canSeeEvent(e, "human:mikko") && !core.canSeeEvent(e, "agent:dev")));
	assert.equal(core.canSee("payments", "agent:ops", "dm-ops-anna"), true, "the DM's own agent takes part");
});

test("who may post: operators and approvers yes, viewers no, agents only where present, nobody in an archived case", () => {
	const { core } = world();
	assert.equal(core.canPost("payments", "human:olli", "general"), true);
	assert.equal(core.canPost("payments", "human:vera", "general"), false);
	assert.equal(code(() => core.postMessage("payments", "general", "human:vera", { text: "hi" })), "forbidden");
	core.createSpace("payments", { id: "pay-412", kind: "case", name: "PAY-412", agentIds: ["agent:ops"] }, "human:anna");
	assert.equal(core.canPost("payments", "agent:dev", "pay-412"), false, "dev is not in the case");
	core.postMessage("payments", "pay-412", "agent:ops", { text: "looking" });
	core.setSpaceStatus("payments", "pay-412", "archived", "human:anna");
	assert.equal(code(() => core.postMessage("payments", "pay-412", "human:anna", { text: "more" })), "forbidden");
	assert.equal(core.listMessages("payments", "pay-412", "human:vera").length, 1, "archived stays readable");
	assert.equal(code(() => core.setSpaceStatus("payments", "general", "archived", "human:anna")), "invalid", "standing rooms are permanent");
	core.setSpaceStatus("payments", "pay-412", "open", "human:anna");
	assert.equal(core.canPost("payments", "human:anna", "pay-412"), true);
});

test("messages are idempotent per requestId; streaming updates are silent, completion is one event", () => {
	const { core } = world();
	const a = core.postMessage("payments", "general", "agent:ops", { text: "", status: "working", requestId: "run:1" });
	const b = core.postMessage("payments", "general", "agent:ops", { text: "ignored", requestId: "run:1" });
	assert.equal(b.created, false);
	assert.equal(b.message.id, a.message.id);
	const before = core.events("payments").length;
	core.updateMessage("payments", a.message.id, "agent:ops", { text: "Looking" });
	core.updateMessage("payments", a.message.id, "agent:ops", { text: "Looking at logs" });
	assert.equal(core.events("payments").length, before, "token deltas do not touch the log");
	core.updateMessage("payments", a.message.id, "agent:ops", { status: "done" });
	assert.equal(core.events("payments").at(-1)!.type, "message.completed");
	assert.equal(core.getMessage("payments", a.message.id)?.text, "Looking at logs");
	assert.equal(code(() => core.updateMessage("payments", a.message.id, "agent:dev", { text: "hijack" })), "forbidden");
	assert.equal(code(() => core.postMessage("payments", "general", "human:anna", { text: "  " })), "invalid");
});

test("mentions split into agents present and agents of the realm that are not in the space", () => {
	const { core } = world();
	core.createSpace("payments", { id: "pay-1", kind: "case", name: "PAY-1", agentIds: ["agent:ops"] }, "human:anna");
	assert.deepEqual(core.mentions("payments", "pay-1", "@ops and @dev please, also @nobody and @Ops"), { present: ["agent:ops"], absent: ["agent:dev"] });
});

test("a decision card appears in the work's space and follows the decision", () => {
	const { core } = world();
	core.createWork("payments", { id: "w1", kind: "tr", title: "TR-1", state: "working", spaceId: "general" }, "agent:ops");
	const { decision } = core.requestDecision("payments", { key: "k", workId: "w1", question: "Apply POOL_SIZE=4?", context: { target: "checkout-api" } }, "agent:ops");
	let card = core.listMessages("payments", "general", "human:anna").find((m) => m.kind === "decision")!;
	assert.equal(card.meta.status, "open");
	assert.equal(card.meta.decisionId, decision.id);
	assert.equal(card.authorId, "agent:ops");
	core.decide("payments", decision.id, "human:anna", "approve", "ok");
	card = core.getMessage("payments", card.id)!;
	assert.deepEqual([card.meta.status, card.meta.answer, card.meta.decidedBy, card.meta.note], ["decided", "approve", "Anna", "ok"]);
	// the same request again does not post a second card
	core.requestDecision("payments", { key: "k", workId: "w1", question: "Apply POOL_SIZE=4?" }, "agent:ops");
	assert.equal(core.listMessages("payments", "general", "human:anna").filter((m) => m.kind === "decision").length, 1);
});

test("decisions and focus follow space visibility: other people's DM work never shows up", () => {
	const { core } = world();
	core.createSpace("payments", { id: "dm-ops-anna", kind: "dm", name: "Ops", ownerId: "human:anna", agentIds: ["agent:ops"] }, "system");
	core.createWork("payments", { id: "w1", kind: "private", title: "Anna's thing", state: "working", spaceId: "dm-ops-anna" }, "agent:ops");
	core.requestDecision("payments", { key: "k", workId: "w1", question: "Private?", requiredAuthority: "operator" }, "agent:ops");
	assert.equal(core.focus("payments", "human:anna").needsYou.length, 1);
	const mikko = core.focus("payments", "human:mikko");
	assert.equal(mikko.needsYou.length + mikko.working.length + mikko.waiting.length + mikko.attention.length, 0);
	const evs = core.events("payments").filter((e) => e.subjectId === "w1" || e.data.workId === "w1");
	assert.ok(evs.length > 0 && evs.every((e) => !core.canSeeEvent(e, "human:mikko")));
});

test("delegation: agents only, not from a DM, both present, bounded depth, no repeats, rate limit, idempotent", () => {
	const { core, tick } = world();
	const d = (o: Partial<{ from: string; to: string; request: string; requestId: string; depth: number; spaceId: string }> = {}) =>
		core.delegate("payments", { spaceId: "general", from: "agent:ops", to: "agent:dev", request: "fix pool size", requestId: `r${Math.random()}`, depth: 0, ...o });
	assert.equal(d({ requestId: "ask:1" }).created, true);
	const again = d({ requestId: "ask:1", request: "other" });
	assert.deepEqual([again.created, again.depth], [false, 1], "a replay is a no-op");
	assert.equal(core.listMessages("payments", "general", "human:anna").filter((m) => m.kind === "delegation").length, 1, "and posts no second message");
	assert.equal(code(() => d({ from: "human:anna" })), "forbidden");
	assert.equal(code(() => d({ to: "human:anna" })), "invalid");
	assert.equal(code(() => d({ to: "agent:ops" })), "invalid");
	assert.equal(code(() => d({ request: "FIX pool size" })), "conflict", "same ask within 10 minutes");
	assert.equal(code(() => d({ request: "new", depth: 3 })), "forbidden", "depth limit");
	core.createSpace("payments", { id: "dm-ops-anna", kind: "dm", name: "Ops", ownerId: "human:anna", agentIds: ["agent:ops"] }, "system");
	assert.equal(code(() => d({ spaceId: "dm-ops-anna", request: "x" })), "forbidden");
	core.createSpace("payments", { id: "pay-9", kind: "case", name: "PAY-9", agentIds: ["agent:ops"] }, "human:anna");
	assert.equal(code(() => d({ spaceId: "pay-9", request: "x" })), "not_found", "dev is not in that space");

	for (let i = 0; i < 7; i++) d({ request: `task ${i}` });
	assert.equal(code(() => d({ request: "one too many" })), "forbidden", "8 per 10 minutes");
	tick(11 * 60_000);
	assert.equal(d({ request: "later" }).created, true, "the window moves on");
});

test("outbox: a message and its wake-ups are committed together, pending until a runtime confirms", () => {
	const { core } = world();
	const { message } = core.postMessage("payments", "general", "human:anna", { text: "@ops @dev go", dispatchTo: ["agent:ops", "agent:dev"] });
	assert.deepEqual(core.trusted.pendingOutbox().map((o) => [o.messageId, o.agentId, o.depth, o.from]), [[message.id, "agent:ops", 0, "human:anna"], [message.id, "agent:dev", 0, "human:anna"]]);
	const [first] = core.trusted.pendingOutbox();
	core.trusted.markOutbox(first.id, "sent");
	assert.equal(core.trusted.pendingOutbox().length, 1);
	assert.equal(core.trusted.bumpOutbox(core.trusted.pendingOutbox()[0].id, "boom"), 1);
	assert.equal(code(() => core.postMessage("payments", "general", "human:anna", { text: "x", dispatchTo: ["agent:ghost"] })), "invalid");
	assert.equal(code(() => core.postMessage("payments", "general", "agent:ops", { text: "x", dispatchTo: ["agent:ops"] })), "invalid", "an agent cannot wake itself");
});

test("a failed post leaves no outbox rows; a delegation queues its wake-up with the next depth", () => {
	const { core } = world();
	core.createSpace("payments", { id: "pay-1", kind: "case", name: "PAY-1", agentIds: ["agent:ops"] }, "human:anna");
	assert.equal(code(() => core.postMessage("payments", "pay-1", "human:anna", { text: "x", dispatchTo: ["agent:dev"] })), "invalid");
	assert.equal(core.trusted.pendingOutbox().length, 0);
	core.delegate("payments", { spaceId: "general", from: "agent:ops", to: "agent:dev", request: "fix it", requestId: "ask:7", depth: 1 });
	const [o] = core.trusted.pendingOutbox();
	assert.deepEqual([o.agentId, o.depth, o.text, o.from], ["agent:dev", 2, "fix it", "agent:ops"]);
});

test("delegation: one agent run can hand work on only so many times", () => {
	const { core } = world();
	const d = (n: number, runId = "run:1") => core.delegate("payments", { spaceId: "general", from: "agent:ops", to: n % 2 ? "agent:dev" : "agent:rev", request: `task ${n}`, requestId: `r${n}-${runId}`, depth: 0, runId });
	d(1); d(2);
	assert.equal(code(() => d(3)), "forbidden", "the third hand-over in one run is refused");
	assert.equal(d(4, "run:2").created, true, "another run has its own allowance");
});
