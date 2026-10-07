import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, createSession, MemoryStorage, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { PiTranscript, leafOf } from "../src/adapters/pi/transcript.ts";
import { openDb } from "../src/core/db.ts";
import { OptChat, openMemoryDb } from "../src/memory/optchat.ts";

const ts = 1_700_000_000_000;
const tsOf = (i: number) => ts + i * 60_000;
const user = (text: string) => ({ model: [{ role: "user", content: text, timestamp: ts }] }) as any;
const assistant = (text: string) =>
	({ model: [{ role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id: "c", name: "k8s_logs", arguments: { pod: "checkout" } }], timestamp: ts }] }) as any;
const toolResult = (text: string) => ({ model: [{ role: "toolResult", toolCallId: "c", toolName: "k8s_logs", content: [{ type: "text", text }], isError: false, timestamp: ts }], data: {} }) as any;

async function history(n: number) {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const conv = await session.commit(async (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx);
	for (let i = 0; i < n; i++) {
		await session.commit(async (tx) => {
			await tx.appendEntry(UserEntry, conv.id, user(`question ${i}`));
			await tx.appendEntry(AssistantEntry, conv.id, assistant(`answer ${i}`));
			await tx.appendEntry(ToolResultEntry, conv.id, toolResult(`log line ${i}`));
		}, ctx);
	}
	return { storage, session, thread: String(conv.id) };
}

test("leafOf maps Pi entries to memory text and ignores non-conversation entries", () => {
	assert.deepEqual(leafOf({ kind: "pi.user", model: user("hi").model }), { role: "user", raw: "hi", ts }, "the message's own time travels with it");
	assert.match(leafOf({ kind: "pi.assistant", model: assistant("done").model })!.raw, /^done\s+\[called k8s_logs\(\{"pod":"checkout"\}\)\]$/);
	assert.match(leafOf({ kind: "pi.tool-result", model: toolResult("ok").model })!.raw, /^k8s_logs: ok$/);
	assert.equal(leafOf({ kind: "pi.system", model: undefined }), undefined);
});

test("the whole history is read in order from Pi's paged scanEntries, even with a tiny page size", async () => {
	const { storage, thread } = await history(5);
	const src = new PiTranscript(storage, ctx, 4);
	const got: number[] = [];
	for await (const e of src.entriesAfter(thread, 0)) got.push(e.entryId);
	assert.equal(got.length, 15);
	assert.deepEqual(got, [...got].sort((a, b) => a - b), "oldest first although Pi scans newest first");
});

test("OptChat is rebuilt from Pi storage alone, and catch-up after a restart adds only new entries", async () => {
	const { storage, session, thread } = await history(4);
	const mem = new OptChat(openMemoryDb(":memory:"));
	const src = new PiTranscript(storage, ctx);
	assert.equal(await mem.sync(thread, src), 12);
	assert.equal(mem.leafCount(thread), 12);

	mem.drop(thread); // lose the derivative entirely
	assert.equal(await mem.sync(thread, src), 12);

	await session.commit(async (tx) => { await tx.appendEntry(UserEntry, Number(thread) as any, user("one more")); }, ctx);
	assert.equal(await mem.sync(thread, src), 1);
	assert.match(mem.zoom(thread, "#0.12"), /one more/);
});

test("entries before a context reset stay readable, so the memory keeps what the active view dropped", async () => {
	const { storage, session, thread } = await history(3);
	await session.commit(async (tx) => {
		await tx.appendEntry(UserEntry, Number(thread) as any, { ...user("after reset"), head: "self" } as any);
	}, ctx);
	const mem = new OptChat(openMemoryDb(":memory:"));
	assert.equal(await mem.sync(thread, new PiTranscript(storage, ctx)), 10, "9 old entries + the one after the reset");
	assert.match(mem.zoom(thread, "#0.0"), /question 0/);
});

test("project(): a generation interrupted by a crash (an aborted partial) is not part of the answer", async () => {
	const { project } = await import("../src/adapters/pi/runtime.ts");
	const e = (id: number, kind: string, msg: any) => ({ id, conversationId: 1, kind, model: [msg] }) as any;
	const out = project([
		e(1, "pi.assistant", { role: "assistant", stopReason: "error", content: [] }),
		e(2, "pi.assistant", { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Connection pools reuse conn" }] }),
		e(3, "pi.assistant", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Connection pools reuse connections." }] }),
	]);
	assert.equal(out.text, "Connection pools reuse connections.");
});

test("rebuilt memory keeps each message's real time, not the time of the rebuild", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const conv = await session.commit(async (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx);
	await session.commit(async (tx) => {
		await tx.appendEntry(UserEntry, conv.id, { model: [{ role: "user", content: "old question", timestamp: tsOf(0) }] } as any);
		await tx.appendEntry(AssistantEntry, conv.id, { model: [{ role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: tsOf(1) }] } as any);
	}, ctx);
	const mem = new OptChat(openMemoryDb(":memory:"));
	await mem.sync(String(conv.id), new PiTranscript(storage, ctx));
	assert.deepEqual((mem.db.prepare("SELECT ts FROM memleaves WHERE thread = ? ORDER BY idx").all(String(conv.id)) as any[]).map((r) => r.ts), [tsOf(0), tsOf(1)]);
	assert.match(mem.zoom(String(conv.id), "#0.0"), /at 2023-11-14/, "the date shown is the original one");
});
