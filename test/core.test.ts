import { test } from "node:test";
import assert from "node:assert/strict";
import { seededRealm, testCore } from "./helpers.ts";
import { CoreError } from "../src/core/errors.ts";

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		return e instanceof CoreError ? e.code : `other:${(e as Error).message}`;
	}
	return "none";
};

test("realm creation is idempotent and adds the system actor", () => {
	const { core } = testCore();
	const a = core.createRealm({ id: "personal", name: "Me", kind: "personal" });
	assert.deepEqual(core.createRealm({ id: "personal", name: "ignored", kind: "team" }), a);
	assert.equal(core.getActor("personal", "system")?.kind, "system");
	assert.equal(code(() => core.createRealm({ id: "Bad Id", name: "x", kind: "team" })), "invalid");
});

test("nothing crosses a realm boundary", () => {
	const { core } = seededRealm();
	core.createRealm({ id: "other", name: "Other", kind: "team" });
	core.addActor("other", { id: "human:eve", kind: "human", name: "Eve", roles: ["approver"] });
	const w = core.createWork("payments", { id: "w1", kind: "incident", title: "Checkout down" }, "agent:ops");
	assert.equal(core.getWork("other", w.id), undefined);
	assert.equal(core.listWork("other").length, 0);
	assert.equal(code(() => core.setWorkState("other", w.id, "working", "human:eve")), "not_found");
	// an actor of realm A cannot act in realm B, even with a valid work id there
	assert.equal(code(() => core.createWork("other", { kind: "x", title: "t" }, "agent:ops")), "forbidden");
	assert.equal(core.events("other").every((e) => e.realmId === "other"), true);
});

test("every mutation needs a member actor", () => {
	const { core } = seededRealm();
	assert.equal(code(() => core.createWork("payments", { kind: "x", title: "t" }, "human:ghost")), "forbidden");
	assert.equal(code(() => core.addActor("payments", { id: "system", kind: "agent", name: "x" })), "forbidden");
	assert.equal(code(() => core.addActor("payments", { id: "human:anna", kind: "agent", name: "Anna" })), "conflict");
});

test("events are append-only at the database level", () => {
	const { core, db } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "x", title: "t" }, "agent:ops");
	assert.throws(() => db.prepare("UPDATE events SET type = 'x'").run(), /append-only/);
	assert.throws(() => db.prepare("DELETE FROM events").run(), /append-only/);
});

test("work is idempotent, states are final when terminal, and every change is an event", () => {
	const { core } = seededRealm();
	const a = core.createWork("payments", { id: "w1", kind: "tr", title: "TR-1" }, "agent:ops");
	assert.deepEqual(core.createWork("payments", { id: "w1", kind: "tr", title: "other" }, "agent:ops"), a);
	core.setWorkState("payments", "w1", "working", "agent:ops", { phase: "triage" });
	core.setWorkState("payments", "w1", "working", "agent:ops", { phase: "triage" }); // no-op, no event
	core.setWorkState("payments", "w1", "done", "agent:ops");
	assert.equal(code(() => core.setWorkState("payments", "w1", "working", "agent:ops")), "conflict");
	const types = core.events("payments").filter((e) => e.subjectId === "w1").map((e) => e.type);
	assert.deepEqual(types, ["work.created", "work.state", "work.state"]);
});

test("a failed transaction leaves no projection change, no event and notifies nobody", () => {
	const { core } = seededRealm();
	const seen: string[] = [];
	core.subscribe((e) => seen.push(e.type));
	const before = core.events("payments").length;
	assert.throws(() => core.tx(() => {
		core.createWork("payments", { id: "w9", kind: "x", title: "t" }, "agent:ops");
		throw new Error("boom");
	}), /boom/);
	assert.equal(core.getWork("payments", "w9"), undefined);
	assert.equal(core.events("payments").length, before);
	assert.deepEqual(seen, []);
	core.createWork("payments", { id: "w9", kind: "x", title: "t" }, "agent:ops");
	assert.deepEqual(seen, ["work.created"], "subscribers hear about it after commit");
});

test("external refs: unique per source object, state is cached, only changes make events", () => {
	const { core } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "tr", title: "TR-1" }, "agent:ops");
	core.createWork("payments", { id: "w2", kind: "tr", title: "TR-2" }, "agent:ops");
	core.linkRef("payments", "w1", { source: "gerrit", externalId: "18422", label: "change 18422" }, "agent:ops");
	core.linkRef("payments", "w1", { source: "gerrit", externalId: "18422" }, "agent:ops"); // idempotent
	assert.equal(code(() => core.linkRef("payments", "w2", { source: "gerrit", externalId: "18422" }, "agent:ops")), "conflict");
	core.observeRef("payments", "gerrit", "18422", "PS4 verified", "system");
	core.observeRef("payments", "gerrit", "18422", "PS4 verified", "system");
	assert.equal(core.events("payments").filter((e) => e.type === "ref.observed").length, 1);
	assert.equal(core.refsOf("payments", "w1")[0].state, "PS4 verified");
	assert.equal(code(() => core.observeRef("payments", "gerrit", "nope", "x", "system")), "not_found");
});

test("decision request is idempotent per key and puts the work in waiting", () => {
	const { core } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "tr", title: "TR-1", state: "working" }, "agent:ops");
	const a = core.requestDecision("payments", { key: "tr1-deploy", workId: "w1", question: "Deploy PS4?" }, "agent:ops");
	const b = core.requestDecision("payments", { key: "tr1-deploy", workId: "w1", question: "Deploy PS4?" }, "agent:ops");
	assert.equal(a.created, true);
	assert.equal(b.created, false);
	assert.equal(b.decision.id, a.decision.id);
	assert.equal(core.getWork("payments", "w1")?.state, "waiting");
	assert.equal(core.openAttention("payments").length, 1);
	assert.equal(code(() => core.requestDecision("payments", { key: "k2", workId: "w1", question: "x", options: ["only"] }, "agent:ops")), "invalid");
});

test("deciding: authority, humans only, separation of duties, Echo, first decision wins", () => {
	const { core } = seededRealm();
	core.addActor("payments", { id: "human:req", kind: "human", name: "Requester", roles: ["approver"] });
	core.createWork("payments", { id: "w1", kind: "tr", title: "TR-1", state: "working" }, "agent:ops");
	const { decision: d } = core.requestDecision("payments", { key: "k", workId: "w1", question: "Deploy?" }, "agent:ops");

	assert.equal(code(() => core.decide("payments", d.id, "human:olli", "approve")), "forbidden", "operator lacks the approver role");
	assert.equal(code(() => core.decide("payments", d.id, "agent:ops", "approve")), "forbidden", "agents never decide");
	assert.equal(code(() => core.decide("payments", d.id, "human:anna", "maybe")), "invalid");

	core.setPresence("payments", "human:anna", "away", { echo: true });
	assert.match(String((() => { try { core.decide("payments", d.id, "human:anna", "approve"); } catch (e) { return (e as Error).message; } })()), /Echo/);
	core.setPresence("payments", "human:anna", "active");

	const done = core.decide("payments", d.id, "human:anna", "approve", "looks fine");
	assert.equal(done.status, "decided");
	assert.equal(done.decidedBy, "human:anna");
	assert.equal(code(() => core.decide("payments", d.id, "human:mikko", "reject")), "conflict", "first decision wins");
	assert.equal(core.getDecision("payments", d.id)?.answer, "approve");
	assert.equal(core.getWork("payments", "w1")?.state, "working", "work resumes");
	assert.equal(core.openAttention("payments").length, 0);
});

test("separation of duties: a human requester cannot decide their own request (when the realm says so)", () => {
	const { core } = seededRealm();
	core.addActor("payments", { id: "human:req", kind: "human", name: "Requester", roles: ["approver"] });
	core.createWork("payments", { id: "w1", kind: "tr", title: "t", state: "working" }, "human:req");
	const { decision } = core.requestDecision("payments", { key: "k", workId: "w1", question: "Go?" }, "human:req");
	assert.equal(code(() => core.decide("payments", decision.id, "human:req", "approve")), "forbidden");
	assert.equal(core.decide("payments", decision.id, "human:anna", "approve").status, "decided");

	core.createRealm({ id: "solo", name: "Solo", kind: "personal", policy: { separationOfDuties: false } });
	core.addActor("solo", { id: "human:me", kind: "human", name: "Me", roles: ["approver"] });
	core.createWork("solo", { id: "w", kind: "x", title: "t", state: "working" }, "human:me");
	const own = core.requestDecision("solo", { key: "k", workId: "w", question: "Go?" }, "human:me").decision;
	assert.equal(core.decide("solo", own.id, "human:me", "approve").status, "decided");
});

test("two approvers racing: exactly one wins, the other gets a conflict", () => {
	const { core } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "tr", title: "t", state: "working" }, "agent:ops");
	const { decision } = core.requestDecision("payments", { key: "k", workId: "w1", question: "Go?" }, "agent:ops");
	const results = ["human:anna", "human:mikko"].map((who) => code(() => core.decide("payments", decision.id, who, "approve")));
	assert.deepEqual(results.sort(), ["conflict", "none"]);
});

test("terminal work cancels its open decisions and clears attention", () => {
	const { core } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "tr", title: "t", state: "working" }, "agent:ops");
	const { decision } = core.requestDecision("payments", { key: "k", workId: "w1", question: "Go?" }, "agent:ops");
	core.setWorkState("payments", "w1", "cancelled", "human:anna");
	assert.equal(core.getDecision("payments", decision.id)?.status, "cancelled");
	assert.equal(core.openAttention("payments").length, 0);
	assert.equal(code(() => core.requestDecision("payments", { key: "k2", workId: "w1", question: "x" }, "agent:ops")), "conflict");
});

test("decisions expire when the clock passes their deadline", () => {
	const { core, tick } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "tr", title: "t", state: "working" }, "agent:ops");
	const { decision } = core.requestDecision("payments", { key: "k", workId: "w1", question: "Go?", expiresAt: 1_700_000_005_000 }, "agent:ops");
	assert.equal(core.expireDecisions(), 0);
	tick(10_000);
	assert.equal(core.expireDecisions(), 1);
	assert.equal(core.getDecision("payments", decision.id)?.status, "expired");
	assert.equal(core.openAttention("payments").length, 0);
});

test("failure and blocked work raise attention and clear it when the work moves on", () => {
	const { core } = seededRealm();
	core.createWork("payments", { id: "w1", kind: "tr", title: "TR-1", state: "working" }, "agent:ops");
	core.setWorkState("payments", "w1", "failed", "agent:ops", { reason: "integration test" });
	core.setWorkState("payments", "w1", "failed", "agent:ops", { reason: "again" });
	assert.deepEqual(core.openAttention("payments").map((a) => a.kind), ["failure"]);
	core.setWorkState("payments", "w1", "blocked", "agent:ops", { reason: "needs env" });
	assert.deepEqual(core.openAttention("payments").map((a) => a.kind), ["blocked"]);
	core.setWorkState("payments", "w1", "working", "agent:ops");
	assert.equal(core.openAttention("payments").length, 0);
});

test("focus is the small human view: needs-you first, only what this person may decide, counts for the rest", () => {
	const { core, tick } = seededRealm();
	for (const i of [1, 2, 3, 4, 5]) core.createWork("payments", { id: `w${i}`, kind: "tr", title: `TR-${i}`, state: i <= 2 ? "working" : "queued" }, "agent:ops");
	core.setWorkState("payments", "w3", "failed", "agent:ops", { reason: "ci" });
	core.setWorkState("payments", "w4", "working", "agent:ops");
	tick();
	core.requestDecision("payments", { key: "low", workId: "w1", question: "Low?", urgency: "low" }, "agent:ops");
	tick();
	core.requestDecision("payments", { key: "high", workId: "w2", question: "High?", urgency: "high" }, "agent:ops");

	const anna = core.focus("payments", "human:anna");
	assert.deepEqual(anna.needsYou.map((n) => n.decision.question), ["High?", "Low?"], "urgent first");
	assert.deepEqual(anna.attention.map((a) => a.kind), ["failure"]);
	assert.deepEqual(anna.working.map((w) => w.id).sort(), ["w4"], "decided-on work is waiting, not working");
	assert.equal(anna.background.count, 1, "w5 is queued and quiet: a count, not a card");
	assert.equal(core.focus("payments", "human:olli").needsYou.length, 0, "an operator is not asked to approve");

	core.setPresence("payments", "human:anna", "away", { echo: true });
	assert.equal(core.focus("payments", "human:anna").needsYou.length, 2, "away humans still see what waits for them");
});
