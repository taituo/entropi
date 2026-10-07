// Races: things that happen at the same moment must end in one consistent state, never two winners or a stuck run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CoreError } from "../src/core/errors.ts";
import { makeWorld, until } from "./pi-world.ts";
import { target } from "./support/target.ts";
import { testCore } from "./helpers.ts";

const ask = (core: any, text: string, meta: any = {}, space = "incidents") => core.postMessage("main", space, "human:anna", { text, dispatchTo: ["agent:ops"], meta }).message;
const replies = (core: any, space = "incidents") => core.listMessages("main", space, "human:anna").filter((m: any) => m.kind === "agent");

test("race: many approvers decide one decision at once over HTTP: exactly one wins, the rest get 409, the answer is the winner's", async () => {
	const t = await target();
	const core = t.core!;
	core.createWork("main", { id: "w-race", kind: "approval", title: "race", ownerId: "agent:ops", spaceId: "general", state: "working" }, "agent:ops");
	const d = core.requestDecision("main", { key: "k-race", workId: "w-race", question: "go?", requiredAuthority: "approver" }, "agent:ops").decision;
	const users = Array.from({ length: 8 }, (_, i) => `approver:racer${i}`);
	const answers = users.map((_, i) => (i % 2 ? "approve" : "reject"));
	const res = await Promise.all(users.map((u, i) => t.call(u, "POST", `/decisions/${d.id}/decide`, { answer: answers[i] })));
	const won = res.map((r, i) => ({ r, i })).filter((x) => x.r.status === 200);
	assert.equal(won.length, 1, `statuses: ${res.map((r) => r.status)}`);
	assert.ok(res.filter((r) => r.status !== 200).every((r) => r.status === 409));
	const final = core.getDecision("main", d.id)!;
	assert.equal(final.status, "decided");
	assert.equal(final.answer, answers[won[0].i]);
	assert.equal(final.decidedBy, `human:approver:racer${won[0].i}`.replace("human:approver:", "human:approver:"), "the recorded decider is the winner");
	assert.equal(core.events("main").filter((e) => e.type === "decision.decided" && e.subjectId === d.id).length, 1, "one decided event");
	await t.close();
});

test("race: deciding at the deadline: the deadline is checked at the moment of deciding, and expiry then deciding is a clean conflict", () => {
	const { core, clock, tick } = testCore();
	core.createRealm({ id: "r", name: "R", kind: "team" });
	core.addActor("r", { id: "agent:a", kind: "agent", name: "A" }, "system");
	core.addActor("r", { id: "human:h", kind: "human", name: "H", roles: ["approver"] }, "system");
	core.createWork("r", { id: "w", kind: "t", title: "t", ownerId: "agent:a", state: "working" }, "agent:a");
	const d = core.requestDecision("r", { key: "k", workId: "w", question: "q", expiresAt: clock.t + 1000 }, "agent:a").decision;
	tick(999);
	assert.equal(core.decide("r", d.id, "human:h", "approve").status, "decided", "one millisecond before the deadline still counts");
	core.createWork("r", { id: "w2", kind: "t", title: "t", ownerId: "agent:a", state: "working" }, "agent:a");
	const d2 = core.requestDecision("r", { key: "k2", workId: "w2", question: "q", expiresAt: clock.t + 1000 }, "agent:a").decision;
	tick(1000);
	assert.throws(() => core.decide("r", d2.id, "human:h", "approve"), (e: any) => e instanceof CoreError && e.code === "conflict", "at the deadline: too late");
	assert.equal(core.trusted.expireDecisions(), 0, "the failed decide had already expired it; the sweeper finds nothing left");
	assert.equal(core.getDecision("r", d2.id)!.status, "expired");
	assert.throws(() => core.decide("r", d2.id, "human:h", "approve"), (e: any) => e instanceof CoreError && e.code === "conflict");
	assert.equal(core.events("r").filter((e) => e.type === "decision.expired" && e.subjectId === d2.id).length, 1, "expired once, not twice");
});

test("race: twenty messages to one agent at the same moment: one conversation, twenty answers, each exactly once, in order", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => ask(w.core, `@ops number ${i}`))));
	await until(() => replies(w.core).filter((r: any) => r.status === "done").length === 20, 30_000);
	const rs = replies(w.core);
	assert.equal(rs.length, 20);
	assert.equal(new Set(rs.map((r: any) => r.text)).size, 20, "no answer twice, none missing");
	assert.equal(new Set(rs.map((r: any) => r.meta.pi.thread)).size, 1, "one conversation");
	assert.equal(w.core.trusted.pendingOutbox().length, 0);
	assert.equal(w.core.trusted.workingMessages().length, 0);
	await w.close();
});

test("race: steer and queue at the same time: both reach the agent, none is lost or answered twice", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops HOLD first");
	await until(() => w.faux.state.callCount >= 1 && w.core.trusted.workingMessages().length === 1);
	ask(w.core, "@ops queued one");
	ask(w.core, "@ops steered one", { steer: true });
	ask(w.core, "@ops queued two");
	await until(() => w.core.listMessages("main", "incidents", "human:anna").filter((m: any) => m.kind === "chat").length === 4);
	w.gate.release();
	await until(() => w.core.trusted.workingMessages().length === 0 && replies(w.core).length >= 3 && replies(w.core).every((r: any) => r.status === "done"), 30_000);
	const texts = replies(w.core).map((r: any) => r.text).join("\n");
	for (const n of ["first", "queued one", "steered one", "queued two"]) assert.ok(texts.includes(n) || /Answered together/.test(texts), `"${n}" was answered`);
	assert.equal(w.core.trusted.pendingOutbox().length, 0);
	const answered = replies(w.core).filter((r: any) => !/Answered together/.test(r.text));
	assert.equal(new Set(answered.map((r: any) => r.text)).size, answered.length, "no duplicate answers");
	await w.close();
});

test("race: stop and a new message at the same moment: the new message is answered or stopped, never stuck, and nothing runs twice", async () => {
	for (let round = 0; round < 5; round++) {
		const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
		await w.start();
		ask(w.core, "@ops HOLD running");
		await until(() => w.faux.state.callCount >= 1 && w.core.trusted.workingMessages().length === 1);
		const stopping = w.runtime.stop({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" });
		ask(w.core, "@ops after the stop");
		await stopping;
		w.gate.release();
		await until(() => w.core.trusted.workingMessages().length === 0 && w.core.trusted.pendingOutbox().length === 0 && replies(w.core).length >= 2, 15_000);
		const rs = replies(w.core);
		assert.ok(rs.every((r: any) => r.status === "done"), `round ${round}: nothing left working`);
		assert.match(rs[0].text, /Stopped/);
		const after = rs.find((r: any) => /after the stop/.test(r.text) || r.meta?.pi?.requestId?.includes(`${rs[1].meta.pi?.requestId?.split(":")[1]}`));
		assert.ok(after, `round ${round}: the second message got an answer (${rs.map((r: any) => r.text.slice(0, 30)).join(" | ")})`);
		assert.equal(rs.filter((r: any) => /echo: @ops after the stop/.test(r.text)).length <= 1, true, "answered at most once");
		await w.close();
	}
});
