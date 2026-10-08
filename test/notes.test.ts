import { test } from "node:test";
import assert from "node:assert/strict";
import { Notes, openNotesDb, MAX_NOTE } from "../src/memory/notes.ts";

const mk = () => new Notes(openNotesDb(":memory:"));
const base = { realmId: "r", agentId: "agent:ops", space: { id: "ops", kind: "standing" }, source: "agent:ops" };

test("notes are idempotent per request id and per text", () => {
	const n = mk();
	const a = n.save({ ...base, text: "POOL_SIZE must never be 0 for checkout-api", requestId: "note:1" });
	assert.equal(a.created, true);
	assert.equal(n.save({ ...base, text: "something else entirely here", requestId: "note:1" }).note.id, a.note.id, "a replayed task finds its note");
	assert.equal(n.save({ ...base, text: "POOL_SIZE must never be 0 for checkout-api" }).created, false, "same text, same scope");
	assert.throws(() => n.save({ ...base, text: "short" }), /too short/);
	assert.ok(n.save({ ...base, text: "x".repeat(900) }).note.text.length <= MAX_NOTE);
});

test("agent-wide notes follow the agent; space notes stay; a private chat never leaks", () => {
	const n = mk();
	n.save({ ...base, text: "agent wide fact for every space" });
	n.save({ ...base, scope: "space", text: "only in the ops space please" });
	const dm = { id: "dm:bob", kind: "dm" };
	const priv = n.save({ ...base, space: dm, scope: "agent", text: "a private thing bob said in confidence" });
	assert.equal(priv.note.scope, "space:dm:bob", "dm notes are space-scoped even when agent-wide was asked");
	const inOps = n.list("r", "agent:ops", "ops", 50).notes.map((x) => x.text);
	assert.ok(inOps.includes("agent wide fact for every space") && inOps.includes("only in the ops space please"));
	assert.ok(!inOps.some((t) => t.includes("private")), "private note not visible in another space");
	const elsewhere = n.list("r", "agent:ops", "other", 50).notes.map((x) => x.text);
	assert.deepEqual(elsewhere, ["agent wide fact for every space"]);
	assert.ok(!n.section("r", "agent:ops", "other").includes("private"));
	assert.deepEqual(n.list("r2", "agent:ops", "ops", 50).notes, [], "another realm sees nothing");
});

test("recall matches every word; visible and delete follow the caller's rights", () => {
	const n = mk();
	n.save({ ...base, text: "checkout-api crash loop was POOL_SIZE zero" });
	n.save({ ...base, scope: "space", text: "approved by alice on tuesday" });
	assert.equal(n.recall("r", "agent:ops", "ops", "crash pool", 10).length, 1);
	assert.equal(n.recall("r", "agent:ops", "ops", "crash alice", 10).length, 0);
	assert.equal(n.visible("r", (s) => s !== "ops").length, 1, "a space the viewer cannot see hides its notes");
	assert.equal(n.visible("r", () => true).length, 2);
	const id = n.list("r", "agent:ops", "ops", 5).notes[0].id;
	assert.equal(n.delete("r", id, () => false), false);
	assert.equal(n.delete("r", id, () => true), true);
	assert.match(n.section("r", "agent:ops", "ops"), /DATA written by you or the system/);
});
