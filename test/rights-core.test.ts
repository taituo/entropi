// The same rules as the API matrix, straight against the core: the API is not the only way in (agents, adapters and
// the next transport all call these methods). Every actor kind x every operation x visible / private space.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreError } from "../src/core/errors.ts";
import { testCore } from "./helpers.ts";

type Out = "ok" | CoreError["code"] | "other";
const out = (fn: () => unknown): Out => { try { fn(); return "ok"; } catch (e) { return e instanceof CoreError ? e.code : "other"; } };

function world() {
	const t = testCore();
	const c = t.core;
	c.createRealm({ id: "r", name: "R", kind: "team" });
	c.createRealm({ id: "other", name: "Other", kind: "team" });
	const human = (id: string, role: string) => c.addActor("r", { id: `human:${id}`, kind: "human", name: id, roles: [role] }, "system");
	human("viewer", "viewer"); human("operator", "operator"); human("approver", "approver"); human("admin", "admin"); human("owner", "operator");
	c.addActor("r", { id: "agent:in", kind: "agent", name: "In" }, "system");
	c.addActor("r", { id: "agent:out", kind: "agent", name: "Out" }, "system");
	c.addActor("other", { id: "human:stranger", kind: "human", name: "S", roles: ["admin"] }, "system");
	c.createSpace("r", { id: "chan", kind: "standing", name: "chan", agentIds: ["agent:in"] }, "system");
	c.createSpace("r", { id: "dm", kind: "dm", name: "dm", ownerId: "human:owner", agentIds: ["agent:in"] }, "system");
	c.createSpace("r", { id: "case", kind: "case", name: "case", agentIds: ["agent:in"] }, "system");
	return { ...t, c };
}
// who: viewer / operator / approver / admin humans, the DM owner (an operator), an agent in the spaces, an agent outside, the system, and an admin of another realm
const WHO = ["human:viewer", "human:operator", "human:approver", "human:admin", "human:owner", "agent:in", "agent:out", "system", "human:stranger"] as const;
type Who = (typeof WHO)[number];
const table = (rows: Record<string, Partial<Record<Who, Out>>>, run: (c: ReturnType<typeof world>, name: string, who: Who) => Out) => {
	const got: Record<string, Record<string, Out>> = {};
	for (const name of Object.keys(rows)) {
		got[name] = {};
		for (const who of WHO) { const w = world(); got[name][who] = run(w, name, who); }
	}
	return got;
};
const fill = (base: Partial<Record<Who, Out>>): Record<Who, Out> => ({ "human:viewer": "forbidden", "human:operator": "ok", "human:approver": "ok", "human:admin": "ok", "human:owner": "ok", "agent:in": "ok", "agent:out": "ok", system: "ok", "human:stranger": "forbidden", ...base } as Record<Who, Out>);

test("core matrix: posting, work and decisions, per actor and space", () => {
	const chan = "chan", dm = "dm";
	const ops: Record<string, (w: ReturnType<typeof world>, who: Who) => unknown> = {
		"post to channel": (w, who) => w.c.postMessage("r", chan, who, { text: "hi" }),
		"post to DM": (w, who) => w.c.postMessage("r", dm, who, { text: "hi" }),
		"post to case": (w, who) => w.c.postMessage("r", "case", who, { text: "hi" }),
		"create work in channel": (w, who) => w.c.createWork("r", { kind: "t", title: "x", spaceId: chan }, who),
		"create work in DM": (w, who) => w.c.createWork("r", { kind: "t", title: "x", spaceId: dm }, who),
		"create work, no space": (w, who) => w.c.createWork("r", { kind: "t", title: "x" }, who),
		"change state of DM work": (w, who) => { w.c.createWork("r", { id: "w", kind: "t", title: "x", spaceId: dm }, "human:owner"); return w.c.setWorkState("r", "w", "working", who); },
		"change state of channel work": (w, who) => { w.c.createWork("r", { id: "w", kind: "t", title: "x", spaceId: chan }, "human:owner"); return w.c.setWorkState("r", "w", "working", who); },
		"link a ref to DM work": (w, who) => { w.c.createWork("r", { id: "w", kind: "t", title: "x", spaceId: dm }, "human:owner"); return w.c.linkRef("r", "w", { source: "s", externalId: "1" }, who); },
		"request a decision on DM work": (w, who) => { w.c.createWork("r", { id: "w", kind: "t", title: "x", spaceId: dm }, "human:owner"); return w.c.requestDecision("r", { key: "k", workId: "w", question: "q" }, who); },
		"request a decision on channel work": (w, who) => { w.c.createWork("r", { id: "w", kind: "t", title: "x", spaceId: chan }, "human:owner"); return w.c.requestDecision("r", { key: "k", workId: "w", question: "q" }, who); },
		"record an event": (w, who) => w.c.record("r", who, "x.y", "space", chan, { spaceId: chan }),
		"archive the case": (w, who) => w.c.setSpaceStatus("r", "case", "archived", who),
		"archive a channel": (w, who) => w.c.setSpaceStatus("r", chan, "archived", who),
		"open a case": (w, who) => w.c.createSpace("r", { kind: "case", name: "another case" }, who),
		"add a member": (w, who) => w.c.addActor("r", { id: "human:new", kind: "human", name: "N", roles: ["admin"] }, who),
		"promote yourself": (w, who) => w.c.addActor("r", { id: who, kind: who.startsWith("agent") ? "agent" : "human", name: "me", roles: ["admin"] }, who),
		"set another's presence": (w, who) => w.c.setPresence("r", "human:viewer", "away", who),
		"add an attachment to DM": (w, who) => w.c.addAttachment("r", dm, who, { id: "a".repeat(32), name: "a.png", mime: "image/png", size: 1 }),
	};
	// "not_found" where the space is private and the actor is not in it: the thing does not exist for them
	const want: Record<string, Record<Who, Out>> = {
		"post to channel": fill({ "human:viewer": "forbidden", "agent:out": "forbidden" }),
		"post to DM": fill({ "human:viewer": "not_found", "human:operator": "not_found", "human:approver": "not_found", "human:admin": "not_found", "agent:out": "not_found", "human:stranger": "forbidden" }),
		"post to case": fill({ "agent:out": "forbidden" }),
		"create work in channel": fill({}),
		"create work in DM": fill({ "human:operator": "not_found", "human:approver": "not_found", "human:admin": "not_found", "agent:out": "not_found" }),
		"create work, no space": fill({}),
		"change state of DM work": fill({ "human:operator": "not_found", "human:approver": "not_found", "human:admin": "not_found", "agent:out": "not_found" }),
		"change state of channel work": fill({}),
		"link a ref to DM work": fill({ "human:operator": "not_found", "human:approver": "not_found", "human:admin": "not_found", "agent:out": "not_found" }),
		"request a decision on DM work": fill({ "human:operator": "not_found", "human:approver": "not_found", "human:admin": "not_found", "agent:out": "not_found" }),
		"request a decision on channel work": fill({}),
		"record an event": fill({}),
		"archive the case": fill({}) /* agents end cases too; viewers cannot */,
		"archive a channel": fill({ "human:viewer": "invalid", "human:operator": "invalid", "human:approver": "invalid", "human:admin": "invalid", "human:owner": "invalid", "agent:in": "invalid", "agent:out": "invalid", system: "invalid" }),
		"open a case": fill({}),
		"add a member": fill({ "human:viewer": "forbidden", "human:operator": "forbidden", "human:approver": "forbidden", "human:owner": "forbidden", "agent:in": "forbidden", "agent:out": "forbidden", "human:stranger": "forbidden" }),
		"promote yourself": fill({ "human:viewer": "forbidden", "human:operator": "forbidden", "human:approver": "forbidden", "human:owner": "forbidden", "agent:in": "forbidden", "agent:out": "forbidden", "human:stranger": "forbidden", system: "forbidden" }),
		"set another's presence": fill({ "human:viewer": "ok", "human:operator": "forbidden", "human:approver": "forbidden", "human:owner": "forbidden", "agent:in": "forbidden", "agent:out": "forbidden", "human:stranger": "forbidden" }),
		"add an attachment to DM": fill({ "human:viewer": "forbidden", "human:operator": "forbidden", "human:approver": "forbidden", "human:admin": "forbidden", "agent:out": "forbidden", "agent:in": "ok", "human:stranger": "forbidden" }),
	};
	const got = table(ops as any, (w, name, who) => out(() => ops[name](w, who)));
	const diffs: string[] = [];
	for (const name of Object.keys(ops)) for (const who of WHO) if (got[name][who] !== want[name][who]) diffs.push(`${name} / ${who}: got ${got[name][who]}, want ${want[name][who]}`);
	assert.deepEqual(diffs, []);
});

test("core matrix: reading a private space through the core says nothing to people outside it", () => {
	const w = world();
	w.c.postMessage("r", "dm", "human:owner", { text: "secret" });
	w.c.createWork("r", { id: "pw", kind: "t", title: "private work", spaceId: "dm" }, "human:owner");
	for (const who of WHO) {
		const mine = who === "human:owner" || who === "agent:in" || who === "system";
		const seen = out(() => { const l = w.c.listMessages("r", "dm", who); if (l.length) return l; throw new CoreError("not_found", "x"); });
		assert.equal(seen === "ok", mine, `${who} reads the DM through listMessages: ${seen}`);
		assert.equal(w.c.canSee("r", who, "dm"), mine, `${who} canSee`);
		assert.equal(w.c.listSpaces("r", who).some((s) => s.id === "dm"), mine, `${who} lists the DM`);
		const touch = out(() => w.c.setWorkState("r", "pw", "working", who));
		assert.equal(touch, mine ? "ok" : who === "human:viewer" || who === "human:stranger" ? "forbidden" : "not_found", `${who} touching private work`);
	}
	// events: everything that happened inside the DM is invisible to everyone outside it
	for (const who of WHO) {
		const mine = who === "human:owner" || who === "agent:in" || who === "system";
		const leaked = w.c.events("r", 0, 1000).filter((e) => e.data.spaceId === "dm" && w.c.canSeeEvent(e, who));
		assert.equal(leaked.length > 0, mine, `${who} sees DM events: ${leaked.length}`);
	}
	const pw = w.c.events("r", 0, 1000).filter((e) => e.subjectId === "pw");
	assert.ok(pw.length > 0 && pw.every((e) => e.data.spaceId === "dm"), "events of private work carry their space");
	for (const who of ["human:viewer", "human:approver", "human:admin", "agent:out"] as const) assert.ok(pw.every((e) => !w.c.canSeeEvent(e, who)), `${who} cannot see private work's events`);
});

test("core matrix: cross-realm: nobody reaches into another realm, whatever their role there", () => {
	const w = world();
	const s = "human:stranger";
	assert.equal(out(() => w.c.postMessage("r", "chan", s, { text: "x" })), "forbidden");
	assert.deepEqual((() => { try { return w.c.listMessages("r", "chan", s); } catch { return []; } })(), []);
	assert.equal(w.c.canSee("r", s, "chan"), false);
	assert.deepEqual(w.c.listSpaces("r", s), []);
	assert.equal(out(() => w.c.decide("r", "nope", s, "approve")), "forbidden", "not a member: refused before anything is looked up");
	assert.equal(out(() => w.c.createWork("r", { kind: "t", title: "x" }, s)), "forbidden");
	w.c.postMessage("r", "chan", "human:operator", { text: "real" });
	assert.ok(w.c.events("r").every((e) => !w.c.canSeeEvent(e, s)), "no event of realm r is visible to a member of another realm");
	assert.equal(w.c.getMessage("other", 1), undefined, "ids are scoped by realm");
});
