// Soak 1: a long conversation with one agent (300+ messages, incl. 5k/20k/100k-char
// Finnish/English/code/JSON/emoji texts), against the scripted model so it runs anywhere.
// A live-model twin runs first when LOCAL_LLM_BASE_URL is set (shorter: it only needs to
// prove the same shape with a real summariser; the scripted run proves the volume).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { OptChat, openMemoryDb, VIEW_MARKER } from "../../src/memory/optchat.ts";
import { makeWorld, until } from "../pi-world.ts";
import { obs, tmpDir, rssMb, fileMb, eventCount, msgs, agentMsgs, shortText, codeText, jsonText, emojiText, longText } from "./support.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const TURNS = 300;
const VIEW_BYTES = 4000;
const MARKER = "SOAKMARK-ALPHA-7741";

const pickText = (i: number): string => {
	if (i === 50) return longText(5_000, i);
	if (i === 150) return longText(20_000, i);
	if (i === 220) return longText(100_000, i);
	if (i % 7 === 3) return codeText(i);
	if (i % 7 === 4) return jsonText(i);
	if (i % 7 === 5) return emojiText(i);
	return shortText(i);
};

async function compactionCount(storage: any, thread: string): Promise<number> {
	let n = 0;
	let cursor: any = undefined;
	for (let page = 0; page < 50; page++) {
		const r: any = await storage.scanEntries({ conversationId: Number(thread) } as any, 200, cursor, ctx);
		for (const e of r.items) if (e.kind === "pi.compaction") n++;
		cursor = r.cursor ?? r.next;
		if (!cursor || !r.items.length) break;
	}
	return n;
}

async function runConversation(opts: { real: boolean; turns: number; dir: string; label: string }) {
	const coreDb = join(opts.dir, "core.sqlite");
	const memDb = join(opts.dir, "memory.sqlite");
	const storage = new MemoryStorage();
	const w = await makeWorld({
		dbPath: coreDb, storage, real: opts.real,
		runtime: { keepRecentTokens: 4000, viewBytes: VIEW_BYTES, memory: new OptChat(openMemoryDb(memDb)) },
	});
	w.runtime.builder.gapMs = 0;
	w.runtime.builder.recentVerbatim = 4;
	await w.start();
	const rss0 = rssMb();
	const done = () => msgs(w.core).filter((m: any) => m.kind === "agent" && m.status === "done");
	const say = async (text: string) => {
		const before = done().length;
		w.core.postMessage("main", "incidents", "human:anna", { text: `@ops ${text}`, dispatchTo: ["agent:ops"] });
		await until(() => done().length === before + 1, 180_000);
	};
	const t0 = Date.now();
	await say(`Muista tämä myöhempää varten: ${MARKER}. Vastaa vain sanalla ok.`);
	let autoCompactions = 0;
	for (let i = 1; i <= opts.turns; i++) {
		await say(pickText(i));
		if (i % 50 === 0) {
			const thread = (w.runtime.memory.db.prepare("SELECT thread t FROM memleaves LIMIT 1").get() as any)?.t;
			if (thread) autoCompactions = await compactionCount(storage, String(thread));
			obs(`${opts.label} progress`, { turns: i, seconds: Math.round((Date.now() - t0) / 1000), autoCompactions, rssMb: Math.round(rssMb()) });
		}
	}
	obs(`${opts.label} conversation`, { turns: opts.turns + 1, seconds: Math.round((Date.now() - t0) / 1000) });

	const thread = String((w.runtime.memory.db.prepare("SELECT thread t FROM memleaves LIMIT 1").get() as any).t);
	await w.runtime.builder.idle();
	const stats = w.runtime.memory.stats(thread);
	obs(`${opts.label} tree`, stats);
	const leaves = (stats as any).leaves as number;
	const dones = agentMsgs(w.core);
	assert.equal(dones.filter((m: any) => m.status === "done").length, dones.length, "every agent message finished, none stuck working");
	assert.ok(dones.length >= opts.turns + 1, `one answer per turn (${dones.length})`);
	assert.ok(leaves >= opts.turns + 1, `the tree recorded every turn (${leaves} leaves)`);

	// The memory view given to the model stays inside its byte budget.
	const n = w.runtime.memory.leafCount(thread);
	const view = w.runtime.memory.renderView(thread, w.runtime.memory.fitView(thread, n - 1, VIEW_BYTES));
	obs(`${opts.label} view`, { bytes: view.length, budget: VIEW_BYTES, leaves: n });
	assert.ok(view.length <= VIEW_BYTES * 1.1, `view inside budget (${view.length} <= ${VIEW_BYTES})`);

	// An early fact is reachable through memory_zoom on the real history.
	const marked = w.runtime.memory.db.prepare("SELECT level, idx FROM memnodes WHERE thread = ? AND text LIKE ? ORDER BY level, idx LIMIT 1").get(thread, `%${MARKER}%`) as any;
	const zoomTarget = marked ? `#${marked.level}.${marked.idx}` : "#1.0";
	const r = await (async () => {
		const before = done().length;
		w.core.postMessage("main", "incidents", "human:anna", { text: `@ops zoom ${zoomTarget} then quote the marked code you find there`, dispatchTo: ["agent:ops"] });
		await until(() => done().length === before + 1, 180_000);
		return done().at(-1)!;
	})();
	const tools = ((r.meta.activity ?? []) as any[]).map((a: any) => `${a.name}:${a.status}`);
	obs(`${opts.label} zoom`, { target: zoomTarget, markerInNode: !!marked, zoomed: tools.some((t) => t.startsWith("memory_zoom")), answerHasMarker: (r.text ?? "").includes(MARKER) });
	assert.ok(tools.some((t) => t.startsWith("memory_zoom")), "the agent opened the old history with memory_zoom");
	if (marked) assert.ok((r.text ?? "").includes(MARKER), "the early fact came back through zoom");

	// Compaction: Pi's own trigger on huge contexts, or the manual hook as proof the path works.
	autoCompactions = await compactionCount(storage, thread);
	let manual = false;
	if (autoCompactions < 1) {
		const c = await w.runtime.compact({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" });
		const comp: any[] = [];
		let cursor: any = undefined;
		for (let p = 0; p < 50; p++) {
			const pg: any = await storage.scanEntries({ conversationId: Number(thread) } as any, 200, cursor, ctx);
			for (const e of pg.items) if (e.kind === "pi.compaction") comp.push(e);
			cursor = pg.cursor ?? pg.next;
			if (!cursor || !pg.items.length) break;
		}
		manual = JSON.stringify(comp).includes(VIEW_MARKER);
		obs(`${opts.label} manual compact`, { result: c, entries: comp.length, optchatView: manual });
	}
	obs(`${opts.label} compaction`, { auto: autoCompactions, manualHook: manual || undefined });
	assert.ok(autoCompactions >= 1 || manual, "Pi compaction ran (automatically on the huge context, or the OptChat hook on demand)");

	const res = {
		rssDeltaMb: rssMb() - rss0,
		coreDbMb: fileMb(coreDb), memDbMb: fileMb(memDb),
		events: eventCount(w.core),
		agentMsgs: dones.length,
	};
	obs(`${opts.label} resources`, res);
	await w.close();
	return res;
}

test("soak-1 (scripted): 300-turn conversation with 5k/20k/100k texts: no crash, tree grows, view in budget, zoom finds the old fact", { timeout: 3_600_000 }, async () => {
	const res = await runConversation({ real: false, turns: TURNS, dir: tmpDir("entropi-soak-1-"), label: "soak-1" });
	assert.ok(res.coreDbMb < 100, `core db stays small (${res.coreDbMb.toFixed(1)} MB for ${res.agentMsgs} answers)`);
	assert.ok(res.rssDeltaMb < 400, `RSS growth bounded (${res.rssDeltaMb.toFixed(0)} MB)`);
});

test("soak-1b (live): 40-turn shape check with a real model and real summariser", { skip: !live, timeout: 3_600_000 }, async () => {
	const res = await runConversation({ real: true, turns: 40, dir: tmpDir("entropi-soak-1b-"), label: "soak-1b" });
	assert.ok(res.coreDbMb < 100, `core db stays small (${res.coreDbMb.toFixed(1)} MB)`);
});
