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
