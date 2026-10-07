// Long conversation, real model: is an old fact still reachable after OptChat summarised it and Pi compacted the context?
// Two facts are planted early: a short one (likely survives a summary) and a detail buried in a long message (likely does not,
// so the agent has to open the memory view with memory_zoom). Nothing is asserted about the model's cleverness beyond the
// answer itself; the numbers go to the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "../pi-world.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

const LONG = `Here is the full incident write-up so you can keep it in mind. On Tuesday the nightly export for the orders warehouse started failing intermittently. We first suspected the network, then the storage layer, then a bad deploy of the exporter. The timeline: 02:10 first failure, 02:40 retry succeeded, 03:15 second failure, 04:00 on-call paged. Several dashboards were checked and nothing unusual showed in CPU or memory. After a long afternoon of bisecting the exporter versions the team found that the real cause was an expired client certificate on the host named orion-7731, which the exporter uses to reach the warehouse; the certificate had a serial ending 9F3A and expired at midnight. Renewal needs the platform team and takes one working day. In the meantime we run the export by hand. None of this changes the schedule of the quarterly review, the retention policy, or the budget discussion that is planned for next month. Reply with just the word ok.`;

test("long conversation, real model: an old fact is found after summarisation and compaction (and was zoom needed?)", { skip: !live, timeout: 1_800_000 }, async () => {
	const storage = new MemoryStorage();
	const w = await makeWorld({ dbPath: ":memory:", storage, real: true, runtime: { keepRecentTokens: 400, viewBytes: 2500 } });
	w.runtime.builder.gapMs = 0;
	w.runtime.builder.recentVerbatim = 4;
	await w.start();
	const done = () => w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "agent" && m.status === "done");
	let turns = 0;
	const say = async (text: string) => {
		const before = done().length;
		w.core.postMessage("main", "incidents", "human:anna", { text: `@ops ${text}`, dispatchTo: ["agent:ops"] });
		await until(() => done().length === before + 1, 180_000);
		turns++;
		return done().at(-1)!;
	};
	const t0 = Date.now();
	await say("Remember: the project codename is BLUEHERON. Reply with just the word ok.");
	await say(LONG);
	const topics = ["the colour of the sky", "a good name for a cat", "how many days in a leap year", "a synonym for fast", "the capital of Finland", "what a haiku is", "a prime number above 50", "the opposite of cold", "a tree that stays green", "the chemical symbol of gold"];
	for (let round = 0; round < 4; round++) for (const t of topics) await say(`Small talk, answer in at most ten words: ${t}.`);
	obs("conversation", { turns, seconds: Math.round((Date.now() - t0) / 1000) });

	const thread = String(w.runtime.memory.db.prepare("SELECT thread t FROM memleaves LIMIT 1").get()!.t);
	await w.runtime.builder.idle();
	obs("tree", w.runtime.memory.stats(thread));
	const nodes = w.runtime.memory.db.prepare("SELECT level, idx, quality, text FROM memnodes WHERE thread = ? ORDER BY level, idx").all(thread) as any[];
	const keeps = (re: RegExp) => nodes.filter((n) => re.test(n.text)).map((n) => `${n.level}.${n.idx}(${n.quality})`);
	obs("summary nodes mentioning BLUEHERON", keeps(/BLUEHERON/));
	obs("summary nodes mentioning orion-7731", keeps(/orion-7731/));
	obs("summary nodes mentioning 9F3A", keeps(/9F3A/));

	obs("early nodes", nodes.filter((n) => n.level <= 2 && n.idx <= 1).map((n) => `#${n.level}.${n.idx}: ${n.text.slice(0, 220)}`));
	obs("compact", await w.runtime.compact({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" }));
	const view = w.runtime.memory.renderView(thread, w.runtime.memory.fitView(thread, w.runtime.memory.leafCount(thread), 2500));
	obs("view bytes", view.length);

	const ask = async (label: string, q: string, re: RegExp[]) => {
		const t = Date.now();
		const r = await say(q);
		const tools = (r.meta.activity as any[]).map((a) => `${a.name}:${a.status}`);
		obs(`${label} answer`, r.text);
		obs(`${label} calls`, (r.meta.activity as any[]).map((a) => `${a.name}(${JSON.stringify(a.args ?? a.input ?? "").slice(0, 80)})`));
		obs(`${label} result`, { correct: re.every((x) => x.test(r.text)), tools, zoomed: tools.some((x) => x.startsWith("memory_zoom")), seconds: Math.round((Date.now() - t) / 1000) });
		return { ok: re.every((x) => x.test(r.text)), tools };
	};
	obs("view head", view.split("\n").slice(0, 6).join(" | ").slice(0, 900));
	const a = await ask("short fact", "What was the project codename I told you at the start? One sentence.", [/BLUEHERON/]);
	const b = await ask("buried detail", "In the incident write-up I gave you early on, which host had the expired certificate and what was the certificate's serial ending? Do not guess; check the history if you are unsure. One sentence.", [/orion-7731/, /9F3A/i]);
	obs("usage", await w.runtime.usage());
	assert.ok(a.ok, "the short early fact is recalled");
	assert.ok(b.ok, "the buried detail is recalled (directly or through memory_zoom)");
	await w.close();
});
