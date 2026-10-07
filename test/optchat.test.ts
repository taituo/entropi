import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { OptChat, openMemoryDb, VIEW_MARKER } from "../src/memory/optchat.ts";
import { TreeBuilder } from "../src/memory/builder.ts";
import type { TranscriptEntry, TranscriptSource } from "../src/core/ports.ts";

const setup = () => {
	const mem = new OptChat(openMemoryDb(":memory:"));
	const builder = new TreeBuilder(mem);
	builder.gapMs = 0;
	return { mem, builder };
};
const entry = (i: number, size = 400): TranscriptEntry => ({
	entryId: 1000 + i,
	role: i % 3 === 2 ? "tool" : i % 2 ? "assistant" : "user",
	raw: `message ${i} ` + "lorem ipsum ".repeat(Math.ceil(size / 12)),
	ts: 1_700_000_000_000 + i * 60_000,
});
const fill = (mem: OptChat, builder: TreeBuilder, thread: string, n: number, start = 0) => {
	for (let i = start; i < start + n; i++) {
		const e = entry(i);
		const { created } = mem.addLeaf(thread, e.entryId, e.role, e.raw, e.ts);
		if (created) builder.onLeaf(thread);
	}
};

test("leaves are idempotent per entry and tool output is described, not copied", () => {
	const { mem } = setup();
	assert.deepEqual(mem.addLeaf("t", 5, "tool", "x".repeat(3000)), { idx: 0, created: true });
	assert.deepEqual(mem.addLeaf("t", 5, "tool", "again"), { idx: 0, created: false });
	assert.equal(mem.leafCount("t"), 1);
	const view = mem.fitView("t", 0, 10_000);
	assert.ok(view[0].text.length < 260 && view[0].text.startsWith("tool result:"));
	assert.ok(mem.zoom("t", "#0.0").length > 2500, "zoom still returns the original text");
});

test("leaves must arrive in transcript order", () => {
	const { mem } = setup();
	mem.addLeaf("t", 10, "user", "a");
	assert.throws(() => mem.addLeaf("t", 9, "user", "b"), /out of order/);
});

test("builder cascades summaries up the tree", async () => {
	const { mem, builder } = setup();
	builder.summarize = async (texts, level) => `L${level}(${texts.length}) ` + texts.map((t) => t.slice(0, 12)).join("|");
	builder.recentVerbatim = 0;
	fill(mem, builder, "t", 16);
	await builder.idle();
	const s = mem.stats("t");
	assert.equal(s.nodes, 8 + 4 + 2 + 1);
	assert.equal(s.llmNodes, 15);
});

test("recent messages need no summary yet", async () => {
	const { mem, builder } = setup();
	builder.summarize = async () => "should not be called";
	builder.recentVerbatim = 16;
	fill(mem, builder, "t", 16);
	await builder.idle();
	assert.equal(mem.stats("t").nodes, 0);
	fill(mem, builder, "t", 16, 16);
	await builder.idle();
	assert.ok(mem.stats("t").nodes >= 1);
});

test("view covers all history once, fits the budget, recent verbatim, old coarse; early part stable", async () => {
	const { mem, builder } = setup();
	builder.summarize = async (texts) => "sum " + texts.map((t) => t.slice(0, 20)).join(" / ");
	builder.recentVerbatim = 0;
	fill(mem, builder, "t", 64);
	await builder.idle();
	const segs = mem.fitView("t", 63, 5000);
	assert.ok(segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0) <= 5000);
	let next = 0;
	for (const s of segs) { assert.equal(s.lo, next); next = s.hi + 1; }
	assert.equal(next, 64);
	assert.equal(segs.at(-1)!.level, 0);
	assert.ok(segs[0].level >= 2);
	const before = segs.slice(0, 3).map((s) => `${s.level}.${s.idx}`);
	fill(mem, builder, "t", 2, 64);
	await builder.idle();
	assert.deepEqual(mem.fitView("t", 65, 5000).slice(0, 3).map((s) => `${s.level}.${s.idx}`), before);
});

test("without a summariser the view still works and zoom navigates down", () => {
	const { mem, builder } = setup();
	fill(mem, builder, "t", 32);
	const segs = mem.fitView("t", 31, 4000);
	assert.ok(segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0) <= 4000);
	const z = mem.zoom("t", `#${segs[0].level}.${segs[0].idx}`);
	assert.match(z, /Finer detail:/);
	assert.throws(() => mem.zoom("t", "nonsense"), /must look like/);
	assert.throws(() => mem.zoom("t", "#0.999"), /no such line/);
	const text = mem.renderView("t", segs);
	assert.ok(text.startsWith(VIEW_MARKER) && /DATA about the past/.test(text));
});

test("a tiny budget degrades gracefully", () => {
	const { mem, builder } = setup();
	fill(mem, builder, "t", 40);
	const segs = mem.fitView("t", 39, 500);
	assert.equal(segs.at(-1)!.hi, 39);
	assert.ok(segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0) <= 1200);
});

// ---------------------------------------------------------------- rebuild: the transcript is the source of truth

const transcript = (n: number): TranscriptSource => ({
	async *entriesAfter(_thread, after) {
		for (let i = 0; i < n; i++) if (1000 + i > after) yield entry(i);
	},
});

test("memory is a derivative: drop it and sync rebuilds identical leaves and the same view", async () => {
	const { mem, builder } = setup();
	const src = transcript(40);
	await mem.sync("t", src, () => builder.onLeaf("t"));
	const view = mem.renderView("t", mem.fitView("t", 39, 4000));
	const raws = mem.db.prepare("SELECT idx, entry_id, raw FROM memleaves WHERE thread = 't' ORDER BY idx").all();

	mem.drop("t");
	assert.equal(mem.leafCount("t"), 0);
	assert.equal(await mem.sync("t", src), 40);
	assert.deepEqual(mem.db.prepare("SELECT idx, entry_id, raw FROM memleaves WHERE thread = 't' ORDER BY idx").all(), raws);
	assert.equal(mem.renderView("t", mem.fitView("t", 39, 4000)), view);
});

test("sync is incremental: a second run adds only what is new", async () => {
	const { mem } = setup();
	assert.equal(await mem.sync("t", transcript(10)), 10);
	assert.equal(await mem.sync("t", transcript(10)), 0);
	assert.equal(await mem.sync("t", transcript(14)), 4);
	assert.equal(mem.leafCount("t"), 14);
	assert.equal(mem.lastEntryId("t"), 1013);
});

test("backfill after a rebuild queues summaries for blocks that no longer exist", async () => {
	const { mem, builder } = setup();
	builder.recentVerbatim = 0;
	await mem.sync("t", transcript(16));
	builder.backfill("t");
	await builder.idle();
	assert.equal(mem.stats("t").nodes, 15);
});
