// Stop with a real model in the middle of a long delegation chain: everything that was started must end, nothing may linger or restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "../pi-world.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

test("stop in a long delegation chain with a real model: every agent stops, nothing hangs, nothing restarts", { skip: !live, timeout: 600_000 }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true });
	await w.start();
	const all = () => w.core.listMessages("main", "incidents", "human:anna").filter((m) => m.kind === "agent");
	const working = () => all().filter((m) => m.status === "working");
	w.core.postMessage("main", "incidents", "human:anna", {
		text: "@ops Use ask_agent to have @developer write a very long, detailed essay (at least 2500 words) on the history of the TCP congestion control algorithms. Wait for the result, then use ask_agent to have @reviewer critique every section of it in detail. Do not write anything yourself.",
		dispatchTo: ["agent:ops"],
	});
	// wait until the chain is really running: someone other than ops is working and has begun to write
	await until(() => working().some((m) => m.authorId !== "agent:ops" && m.text.length > 200), 240_000);
	const before = all().map((m) => `${m.authorId.slice(6)}:${m.status}:${m.text.length}`);
	obs("chain at stop time", before);
	const t0 = Date.now();
	const r = await w.runtime.stop({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" });
	obs("stop result", { stopped: r.stopped });
	await until(() => working().length === 0 && w.core.trusted.workingMessages().length === 0, 30_000);
	obs("everything stopped after ms", Date.now() - t0);
	assert.ok(r.stopped >= 2, `the colleague was stopped too (stopped=${r.stopped})`);

	// quiet period: no new messages, no growing text, no new hand-overs
	const snap = () => JSON.stringify(all().map((m) => [m.id, m.status, m.text.length]));
	const s1 = snap(), outbox = w.core.trusted.pendingOutbox().length, streamed = w.live.length;
	await new Promise((res) => setTimeout(res, 20_000));
	assert.equal(snap(), s1, "nothing changed in 20 s: no restart, no late output");
	assert.equal(w.core.trusted.pendingOutbox().length, 0);
	assert.equal(outbox, 0, "no hand-over left in the outbox");
	assert.equal(w.live.length, streamed, "no more streaming updates");
	obs("final", all().map((m) => `${m.authorId.slice(6)}:${m.status}:${m.text.length}`));
	await w.close();
});
