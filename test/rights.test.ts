// Rights, attacked from every side. Each case calls the core directly (what a buggy transport or a tool could do) and
// expects the same refusal the UI gets. Order of answers matters too: unknown/invisible -> 404, finished -> 409, not allowed -> 403.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testCore } from "./helpers.ts";
import { CoreError } from "../src/core/errors.ts";
import type { Core } from "../src/core/core.ts";

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof CoreError ? e.code : `other:${(e as Error).message}`; } return "none"; };

function world() {
	const t = testCore();
	const { core } = t;
	core.createRealm({ id: "r", name: "R", kind: "team" });
	core.addActor("r", { id: "human:root", kind: "human", name: "Root", roles: ["admin"] }, "system");
	core.addActor("r", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] }, "system");
	core.addActor("r", { id: "human:mikko", kind: "human", name: "Mikko", roles: ["approver"] }, "system");
	core.addActor("r", { id: "human:olli", kind: "human", name: "Olli", roles: ["operator"] }, "system");
	core.addActor("r", { id: "human:vera", kind: "human", name: "Vera", roles: ["viewer"] }, "system");
	core.addActor("r", { id: "agent:ops", kind: "agent", name: "Ops" }, "system");
	core.addActor("r", { id: "agent:dev", kind: "agent", name: "Dev" }, "system");
	core.createSpace("r", { id: "general", kind: "standing", name: "general", agentIds: ["agent:ops"] }, "system");
	core.createSpace("r", { id: "dm-olli", kind: "dm", name: "Ops", ownerId: "human:olli", agentIds: ["agent:ops"] }, "human:olli");
	core.createWork("r", { id: "private-work", kind: "x", title: "Olli's private thing", state: "working", spaceId: "dm-olli" }, "agent:ops");
	const { decision } = core.requestDecision("r", { key: "k", workId: "private-work", question: "Private?", requiredAuthority: "operator" }, "agent:ops");
	return { ...t, core, decision };
}
const everyone = ["human:root", "human:anna", "human:mikko", "human:vera", "agent:dev", "outsider"];

test("membership and roles: nobody promotes themselves, an agent cannot, only an admin or the system can", () => {
	const { core } = world();
	core.addActor("r", { id: "outsider", kind: "human", name: "Outsider" }, "system"); // exists in another way: a person, not a member of the rights below
	assert.equal(code(() => core.addActor("r", { id: "human:vera", kind: "human", name: "Vera", roles: ["admin"] }, "human:vera")), "forbidden", "a viewer promoting themselves");
	assert.equal(code(() => core.addActor("r", { id: "human:olli", kind: "human", name: "Olli", roles: ["admin"] }, "human:olli")), "forbidden", "an operator promoting themselves");
	assert.equal(code(() => core.addActor("r", { id: "human:anna", kind: "human", name: "Anna", roles: ["admin"] }, "human:anna")), "forbidden", "an approver promoting themselves");
	assert.equal(code(() => core.addActor("r", { id: "human:new", kind: "human", name: "New", roles: ["admin"] }, "human:anna")), "forbidden", "an approver adding an admin");
	assert.equal(code(() => core.addActor("r", { id: "human:vera", kind: "human", name: "Vera", roles: ["admin"] }, "agent:ops")), "forbidden", "an agent promoting someone");
	assert.equal(code(() => core.addActor("r", { id: "human:ghost", kind: "human", name: "G" }, "human:stranger")), "forbidden", "a non-member");
	assert.deepEqual(core.getActor("r", "human:vera")!.roles, ["viewer"]);
	assert.equal(code(() => core.addActor("r", { id: "human:vera", kind: "human", name: "Vera", roles: ["operator"] }, "human:root")), "none", "an admin may");
	assert.deepEqual(core.getActor("r", "human:vera")!.roles, ["operator"]);
});

test("nothing changed means nothing written and nothing announced (every request syncs identity, every boot seeds)", () => {
	const { core } = world();
	const before = core.events("r").length;
	core.addActor("r", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] }, "system");
	core.syncIdentity("r", { id: "human:anna", name: "Anna", roles: ["approver"] });
	core.syncIdentity("r", { id: "human:anna", name: "Anna", roles: ["approver"] });
	assert.equal(core.events("r").length, before);
	core.syncIdentity("r", { id: "human:anna", name: "Anna B", roles: ["approver"] });
	assert.equal(core.events("r").length, before + 1, "a real change is recorded once");
});

test("the trusted identity path: only people, only what the provider says; it cannot touch an agent", () => {
	const { core } = world();
	assert.equal(code(() => core.syncIdentity("r", { id: "agent:ops", name: "Evil", roles: ["admin"] })), "forbidden");
	assert.equal(code(() => core.syncIdentity("r", { id: "system", name: "x", roles: [] })), "forbidden");
	core.syncIdentity("r", { id: "human:vera", name: "Vera", roles: ["approver"] }); // her provider upgraded her: that is the provider's call
	assert.deepEqual(core.getActor("r", "human:vera")!.roles, ["approver"]);
	assert.equal(core.getActor("r", "agent:ops")!.kind, "agent");
});

test("a private space's work does not exist for anyone else: every way to touch it is a 404", () => {
	const { core, decision } = world();
	for (const who of everyone) {
		const w = (fn: () => unknown) => code(fn);
		assert.equal(w(() => core.decide("r", decision.id, who, "approve")), who === "outsider" ? "forbidden" : "not_found", `decide as ${who}`);
		if (who === "outsider") continue;
		assert.equal(w(() => core.setWorkState("r", "private-work", "done", who)), who === "human:vera" ? "forbidden" : "not_found", `setWorkState as ${who}`);
		assert.equal(w(() => core.requestDecision("r", { key: `x-${who}`, workId: "private-work", question: "q" }, who)), who === "human:vera" ? "forbidden" : "not_found", `requestDecision as ${who}`);
		assert.equal(w(() => core.linkRef("r", "private-work", { source: "s", externalId: `e-${who}` }, who)), who === "human:vera" ? "forbidden" : "not_found", `linkRef as ${who}`);
		assert.equal(w(() => core.createWork("r", { kind: "x", title: "t", spaceId: "dm-olli" }, who)), who === "human:vera" ? "forbidden" : "not_found", `createWork into the private space as ${who}`);
		assert.equal(w(() => core.postMessage("r", "dm-olli", who, { text: "hi" })), "not_found", `postMessage as ${who}`);
	}
	assert.equal(core.getDecision("r", decision.id)!.status, "open", "nobody changed it");
	assert.equal(core.getWork("r", "private-work")!.state, "waiting");
	core.linkRef("r", "private-work", { source: "s", externalId: "e1" }, "agent:ops");
	assert.equal(code(() => core.observeRef("r", "s", "e1", "x", "human:anna")), "not_found", "observing a ref of invisible work");
	assert.equal(code(() => core.decide("r", decision.id, "human:olli", "approve")), "none", "the owner can");
});

test("the order of answers: finished is 409 even for someone who could not have decided, invisible stays 404", () => {
	const { core } = world();
	core.createWork("r", { id: "w", kind: "x", title: "t", state: "working", spaceId: "general" }, "agent:ops");
	const { decision } = core.requestDecision("r", { key: "pub", workId: "w", question: "Go?" }, "agent:ops");
	assert.equal(code(() => core.decide("r", decision.id, "human:vera", "approve")), "forbidden", "open: a viewer is refused");
	core.decide("r", decision.id, "human:anna", "approve");
	assert.equal(code(() => core.decide("r", decision.id, "human:vera", "approve")), "conflict", "decided: 409 for the viewer too, not 403");
	assert.equal(code(() => core.decide("r", decision.id, "agent:ops", "approve")), "conflict");
	assert.equal(code(() => core.decide("r", "d_missing", "human:vera", "approve")), "not_found");
});

test("a deadline that passed counts at the moment of deciding; nobody has to wait for a timer", () => {
	const { core, tick } = world();
	core.createWork("r", { id: "w", kind: "x", title: "t", state: "working", spaceId: "general" }, "agent:ops");
	const { decision } = core.requestDecision("r", { key: "late", workId: "w", question: "Go?", expiresAt: 1_700_000_005_000 }, "agent:ops");
	tick(10_000);
	assert.equal(code(() => core.decide("r", decision.id, "human:anna", "approve")), "conflict");
	assert.equal(core.getDecision("r", decision.id)!.status, "expired", "and the refusal did not roll the expiry back");
	assert.equal(core.openAttention("r").filter((a) => a.workId === "w").length, 0);
});

test("presence is yours to change (or an admin's), not anybody's", () => {
	const { core } = world();
	assert.equal(code(() => core.setPresence("r", "human:anna", "away", "human:vera")), "forbidden", "a viewer sidelining an approver");
	assert.equal(code(() => core.setPresence("r", "human:anna", "away", "agent:ops")), "forbidden");
	assert.equal(code(() => core.setPresence("r", "human:anna", "away", "human:anna", { echo: true })), "none");
	assert.equal(code(() => core.setPresence("r", "human:anna", "active", "human:root")), "none");
});

test("viewers watch: they cannot change work, record events or open spaces; agents and operators can", () => {
	const { core } = world();
	for (const [name, fn] of [
		["createWork", () => core.createWork("r", { kind: "x", title: "t" }, "human:vera")],
		["setWorkState", () => core.setWorkState("r", "private-work", "done", "human:vera")],
		["record", () => core.record("r", "human:vera", "sandbox.exec", "space", "general", {})],
		["case", () => core.createSpace("r", { kind: "case", name: "my case" }, "human:vera")],
		["standing", () => core.createSpace("r", { kind: "standing", name: "my room" }, "human:vera")],
		["someone else's dm", () => core.createSpace("r", { kind: "dm", name: "xy", ownerId: "human:olli", agentIds: ["agent:dev"] }, "human:vera")],
	] as [string, () => unknown][]) assert.equal(code(fn), "forbidden", name);
	assert.equal(code(() => core.createSpace("r", { kind: "standing", name: "olli room" }, "human:olli")), "forbidden", "an operator cannot create standing rooms");
	assert.equal(code(() => core.createSpace("r", { kind: "case", name: "olli case" }, "human:olli")), "none");
	assert.equal(code(() => core.createSpace("r", { kind: "case", name: "agent case" }, "agent:dev")), "none");
	assert.equal(code(() => core.createSpace("r", { kind: "standing", name: "admin room" }, "human:root")), "none");
	assert.equal(code(() => core.createSpace("r", { id: "dm-vera", kind: "dm", name: "Dev", ownerId: "human:vera", agentIds: ["agent:dev"] }, "human:vera")), "none", "your own private chat is yours to open");
});

test("a space id can never hand you somebody else's private chat", () => {
	const { core } = world();
	assert.equal(code(() => core.createSpace("r", { id: "dm-olli", kind: "dm", name: "Ops", ownerId: "human:vera", agentIds: ["agent:ops"] }, "human:vera")), "conflict", "same id, other owner");
	assert.equal(code(() => core.createSpace("r", { id: "dm-olli", kind: "case", name: "x" }, "human:root")), "conflict", "same id, other kind");
	assert.equal(code(() => core.createSpace("r", { kind: "weird" as any, name: "x" }, "human:root")), "invalid");
});

test("values that become keys are validated, and inherited object properties are not roles", async () => {
	const { core } = world();
	core.createWork("r", { id: "w", kind: "x", title: "t", state: "working", spaceId: "general" }, "agent:ops");
	assert.equal(code(() => core.requestDecision("r", { key: "u", workId: "w", question: "q", urgency: "constructor" as any }, "agent:ops")), "invalid");
	const { hasRole } = await import("../src/core/core.ts");
	assert.equal(hasRole({ roles: ["constructor"] }, "toString"), false);
	assert.equal(hasRole({ roles: ["admin"] }, "constructor"), true, "an admin has any custom role; a made-up ladder name does not exist");
	assert.equal(hasRole({ roles: ["viewer"] }, "constructor"), false);
	assert.equal(hasRole({ roles: ["__proto__"] }, "viewer"), false);
});
