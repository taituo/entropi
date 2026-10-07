// Real inference for OptChat: LLM summaries of the memory tree, and the compaction hook that puts the tree's view into Pi's context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { VIEW_MARKER } from "../../src/memory/optchat.ts";
import { makeWorld, until } from "../pi-world.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

test("3. OptChat with a real summariser and Pi compaction: an early fact survives and is recalled", { skip: !live, timeout: 900_000 }, async () => {
	const storage = new MemoryStorage();
	const w = await makeWorld({ dbPath: ":memory:", storage, real: true, runtime: { keepRecentTokens: 60, viewBytes: 3000 } });
	w.runtime.builder.gapMs = 0;
	w.runtime.builder.recentVerbatim = 4;
	await w.start();
	const say = async (text: string) => {
		const before = w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "agent" && m.status === "done").length;
		w.core.postMessage("main", "incidents", "human:anna", { text: `@ops ${text}`, dispatchTo: ["agent:ops"] });
		await until(() => w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "agent" && m.status === "done").length === before + 1, 120_000);
		return w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "agent").at(-1)!;
	};
	await say("Remember this for later: the project codename is BLUEHERON and the incident id is INC-4417. Reply with just the word ok.");
	for (let i = 1; i <= 12; i++) await say(`what is ${i + 20} + ${i + 30}? Reply with just the number.`);

	const thread = String(w.core.db.prepare("SELECT json_extract(meta, '$.pi.thread') t FROM messages WHERE kind = 'agent' LIMIT 1").get()!.t);
	await w.runtime.builder.idle();
	const stats = w.runtime.memory.stats(thread);
	obs("3 tree", stats);
	assert.ok(stats.leaves >= 26, `leaves recorded (${stats.leaves})`);
	assert.ok(stats.llmNodes >= 1, "the real model wrote at least one summary node");
	const sample = w.core.db.prepare("SELECT level, idx, quality, text FROM memnodes WHERE thread = ? AND quality = 'llm' ORDER BY level, idx LIMIT 3").all(thread);
	obs("3 sample llm summaries", sample.map((r: any) => `${r.level}.${r.idx}: ${r.text}`));
	const first = w.core.db.prepare("SELECT text FROM memnodes WHERE thread = ? AND level = 1 AND idx = 0").get(thread) as any;
	obs("3 first node keeps the early fact?", { text: first?.text, hasCodename: /BLUEHERON/.test(first?.text ?? ""), hasIncident: /4417/.test(first?.text ?? "") });

	const c = await w.runtime.compact({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" });
	obs("3 compact result", c);
	const comp: any[] = [];
	const page = await storage.scanEntries({ conversationId: Number(thread) as any }, 200, undefined, ctx);
	for (const e of page.items) if (e.kind === "pi.compaction") comp.push(e);
	obs("3 compaction entries", comp.map((e: any) => ({ id: e.id, data: JSON.stringify(e.data).slice(0, 300), model: JSON.stringify(e.model ?? "").slice(0, 300) })));
	assert.ok(comp.length >= 1, "Pi wrote a compaction entry");
	const blob = JSON.stringify(comp);
	assert.ok(blob.includes(VIEW_MARKER), "the summary Pi kept is OptChat's view, not Pi's own linear summary (the hook ran)");

	const r = await say("What was the project codename and the incident id I gave you at the start of this conversation? Answer in one sentence.");
	obs("3 recall answer", r.text);
	obs("3 recall tools", (r.meta.activity as any[]).map((a) => `${a.name}:${a.status}`));
	assert.match(r.text, /BLUEHERON/);
	assert.match(r.text, /4417/);
	await w.close();
});
