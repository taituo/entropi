import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "./pi-world.ts";

const ask = (core: any, text: string, space = "incidents") => core.postMessage("main", space, "human:anna", { text, dispatchTo: ["agent:ops"] }).message;
const replies = (core: any, space = "incidents") => core.listMessages("main", space, "human:anna").filter((m: any) => m.kind === "agent");

test("human message -> outbox -> Pi -> the agent's answer appears in the core, once", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	const m = ask(w.core, "@ops hello there");
	await until(() => replies(w.core).some((r: any) => r.status === "done"));
	const [r] = replies(w.core);
	assert.equal(r.authorId, "agent:ops");
	assert.equal(r.text, "echo: @ops hello there");
	assert.equal(w.core.pendingOutbox().length, 0, "the hand-over was confirmed");
	assert.equal(w.core.db.prepare("SELECT status FROM outbox WHERE message_id = ?").get(m.id)!.status, "sent");
	await w.close();
});

test("the same agent in the same space keeps one conversation; another space gets its own", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops one"); ask(w.core, "@ops two");
	await until(() => replies(w.core).filter((r: any) => r.status === "done").length === 2);
	ask(w.core, "@ops three", "general");
	await until(() => replies(w.core, "general").some((r: any) => r.status === "done"));
	const threads = new Set(w.core.db.prepare("SELECT meta FROM messages WHERE kind = 'agent'").all().map((r: any) => JSON.parse(r.meta).pi.thread));
	assert.equal(threads.size, 2);
	await w.close();
});

test("request_approval: a card appears, the tool waits, and the human's verdict is what the agent reports", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops please approve the fix");
	await until(() => w.core.openDecisions("main").length === 1);
	const card = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.kind === "decision")!;
	assert.equal(card.meta.status, "open");
	assert.equal(replies(w.core)[0].status, "working", "the agent is blocked on the human");
	w.core.decide("main", String(card.meta.decisionId), "human:anna", "approve", "go");
	await until(() => replies(w.core)[0].status === "done");
	assert.match(replies(w.core)[0].text, /done: APPROVED by Anna \(go\)/);
	assert.equal(replies(w.core)[0].meta.activity[0].name, "request_approval");
	assert.equal(w.core.openAttention("main").length, 0);
	await w.close();
});

test("request_approval: a rejection reaches the agent as a rejection", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops approve please");
	await until(() => w.core.openDecisions("main").length === 1);
	w.core.decide("main", w.core.openDecisions("main")[0].id, "human:anna", "reject", "not now");
	await until(() => replies(w.core)[0].status === "done");
	assert.match(replies(w.core)[0].text, /REJECTED by Anna: not now/);
	await w.close();
});

test("ask_agent: delegation becomes a message plus an outbox row, and the other agent answers", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops delegate this");
	await until(() => w.core.listMessages("main", "incidents", "human:anna").some((m) => m.kind === "agent" && m.authorId === "agent:developer" && m.status === "done"));
	const del = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.kind === "delegation")!;
	assert.equal(del.authorId, "agent:ops");
	assert.equal(del.meta.to, "developer");
	const dev = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.authorId === "agent:developer" && m.kind === "agent")!;
	assert.equal(dev.meta.depth, 1, "depth travels through the outbox");
	assert.match(dev.text, /echo: @ops \(agent\)|echo:/);
	await w.close();
});

test("live updates are pushed while the agent writes, and the final message equals the transcript projection", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops stream me");
	await until(() => replies(w.core).some((r: any) => r.status === "done"));
	assert.ok(w.live.length >= 1);
	assert.equal(w.live.at(-1), "echo: @ops stream me", "the last push is the final text");
	await w.close();
});

test("images are never dropped silently: a text-only model is told, and so are the people", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops look at this", dispatchTo: ["agent:ops"], meta: { images: [{ name: "screen.png", mime: "image/png" }] } });
	await until(() => replies(w.core).some((r: any) => r.status === "done"));
	const notice = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.kind === "notice" && /NOT sent/.test(m.text))!;
	assert.match(notice.text, /screen\.png.*does not support images|does not forward image data/);
	assert.match(replies(w.core)[0].text, /cannot see them/, "the model's input carries the note too");
	await w.close();
});

test("a model that fans out ask_agent in one turn is stopped by the per-run limit, through the real tool path", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops fanout now");
	await until(() => replies(w.core).some((r: any) => r.status === "done" && r.authorId === "agent:ops"));
	const dels = w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "delegation");
	assert.equal(dels.length, 2, "two hand-overs allowed, the third refused");
	const act = replies(w.core).find((r: any) => r.authorId === "agent:ops").meta.activity;
	assert.equal(act.filter((a: any) => a.status === "error").length, 1, "the model saw the refusal as an error result");
	assert.match(act.find((a: any) => a.status === "error").preview, /already handed work on 2 time/);
	await w.close();
});

const ctlOf = (by = "human:anna") => ({ realmId: "main", spaceId: "incidents", by });

test("stop: aborts the running answer, which says so; late model output changes nothing", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops HOLD this one");
	await until(() => replies(w.core).length === 1 && w.core.workingMessages().length === 1 && w.faux.state.callCount >= 1);
	const r = await w.runtime.stop({ ...ctlOf(), agentId: "agent:ops" });
	assert.ok(r.stopped >= 1);
	await until(() => replies(w.core)[0].status === "done");
	assert.match(replies(w.core)[0].text, /Stopped/);
	w.gate.release(); // the "model" finally answers; nobody is listening any more
	await new Promise((x) => setTimeout(x, 300));
	assert.equal(replies(w.core).length, 1);
	assert.match(replies(w.core)[0].text, /Stopped/);
	assert.ok(w.core.events("main").some((e) => e.type === "agent.stopped"), "the stop is on the record");
	await w.close();
});

test("stop follows an ask_agent chain: the colleague that got the work stops too, and queued hand-overs are withdrawn", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops delegate this HOLDDEV");
	await until(() => w.core.listMessages("main", "incidents", "human:anna").some((m) => m.kind === "agent" && m.authorId === "agent:developer" && m.status === "working"));
	assert.ok(replies(w.core).find((m: any) => m.authorId === "agent:ops").status === "done", "ops itself finished after handing over");
	const dev = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.authorId === "agent:developer" && m.kind === "agent")!;
	assert.equal(String(dev.meta.parentRun).startsWith("run:"), true, "the reply knows which run started it");
	const r = await w.runtime.stop({ ...ctlOf(), agentId: "agent:ops" }); // stop the one who handed over
	assert.ok(r.stopped >= 1);
	await until(() => w.core.getMessage("main", dev.id)!.status === "done");
	assert.match(w.core.getMessage("main", dev.id)!.text, /Stopped/);
	w.gate.release();
	await w.close();
});

test("consult: a hidden helper is a Pi subagent owned by the tool call (not a visible colleague)", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops consult the helper");
	await until(() => replies(w.core).some((r: any) => r.status === "done"));
	assert.match(replies(w.core)[0].text, /done: echo: what is the answer/);
	assert.equal(w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "delegation").length, 0, "nothing visible was handed over");
	assert.equal(replies(w.core)[0].meta.activity[0].name, "consult");
	let owned = 0;
	const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
	const page = await w.runtime.storage.scanConversations({}, 50, undefined, ctx);
	for (const c of page.items) if (c.owner) owned++;
	assert.equal(owned, 1, "the helper conversation is owned by a task");
	await w.close();
});

test("consult: stopping the parent stops the helper it owns (Pi's own abort cascade)", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops consult HOLDHELPER");
	await until(() => w.faux.state.callCount >= 2); // the helper is now blocked inside the gate
	await w.runtime.stop({ ...ctlOf(), agentId: "agent:ops" });
	await until(() => replies(w.core)[0].status === "done");
	assert.match(replies(w.core)[0].text, /Stopped/);
	const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
	const subs = await w.runtime.storage.scanSubmissions({}, 50, undefined, ctx);
	assert.ok(subs.items.every((s) => s.status !== "placed" && s.status !== "queued"), "nothing is left running, helper included");
	w.gate.release();
	await w.close();
});

test("steer: a person's message can join a run in progress instead of queueing behind it", async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage() });
	await w.start();
	ask(w.core, "@ops HOLD the first one");
	await until(() => w.core.workingMessages().length === 1 && w.faux.state.callCount >= 1);
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops also this", dispatchTo: ["agent:ops"], meta: { steer: true } });
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops and this later", dispatchTo: ["agent:ops"] });
	const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
	const convId = (await w.runtime.storage.scanConversations({}, 5, undefined, ctx)).items[0].id;
	const view = await (await w.runtime.harness.conversation(convId, ctx))!.viewState(ctx);
	const modes = () => (((view.value.docs["pi.inbox"] as any)?.items ?? []) as { mode: string }[]).map((x) => x.mode).sort();
	await until(() => modes().length === 2);
	assert.deepEqual(modes(), ["followUp", "steer"], "Pi holds one steer and one follow-up in its inbox");
	view.dispose();
	w.gate.release();
	await until(() => replies(w.core).filter((r: any) => r.status === "done").length === 3, 20_000);
	const texts: string[] = replies(w.core).map((r: any) => String(r.text));
	assert.equal(texts.filter((t) => /Answered together/.test(t)).length, 1, "a message that shared an answer says so instead of repeating it");
	assert.equal(new Set(texts.filter((t) => /^echo:/.test(t))).size, texts.filter((t) => /^echo:/.test(t)).length, "no answer text is shown twice");
	await w.close();
});
