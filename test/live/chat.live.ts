// Real inference. Needs LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL / LOCAL_LLM_API_KEY in the environment (npm run test:live).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "../pi-world.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const T = 120_000;
const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const thread = (core: any, space = "incidents") => core.listMessages("main", space, "human:anna", 500);
const agentMsgs = (core: any, who: string, space = "incidents") => thread(core, space).filter((m: any) => m.kind === "agent" && m.authorId === who);

test("1a. a person asks an agent and a real model answers", { skip: !live, timeout: T }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops what is 17 * 23? Reply with just the number.", dispatchTo: ["agent:ops"] });
	await until(() => agentMsgs(w.core, "agent:ops").some((m: any) => m.status === "done"), T);
	const r = agentMsgs(w.core, "agent:ops")[0];
	obs("1a answer", r.text);
	assert.match(r.text, /391/);
	await w.close();
});

test("1b. request_approval with a real model: card, wait, verdict reaches the answer", { skip: !live, timeout: T }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", {
		text: "@ops I want you to restart the deployment checkout-api in production. That changes a live system, so get a human approval first, then tell me the verdict in one sentence.", dispatchTo: ["agent:ops"],
	});
	await until(() => w.core.openDecisions("main").length >= 1, T);
	const d = w.core.openDecisions("main")[0];
	obs("1b decision", { question: d.question, context: d.context, count: w.core.openDecisions("main").length });
	assert.equal(w.core.openDecisions("main").length, 1, "asked once, not repeatedly");
	assert.equal(agentMsgs(w.core, "agent:ops")[0].status, "working", "the agent is blocked until a human decides");
	w.core.decide("main", d.id, "human:anna", "approve", "go ahead");
	await until(() => agentMsgs(w.core, "agent:ops").some((m: any) => m.status === "done"), T);
	const r = agentMsgs(w.core, "agent:ops")[0];
	obs("1b answer", r.text);
	obs("1b activity", r.meta.activity.map((a: any) => `${a.name}:${a.status}`));
	assert.match(r.text, /approv/i);
	assert.ok(r.meta.activity.some((a: any) => a.name === "request_approval" && a.status === "done"));
	await w.close();
});

test("1c. a rejection is respected: the model reports it and does not ask again", { skip: !live, timeout: T }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops delete the old staging namespace. That is destructive: ask for approval first, and report what was decided.", dispatchTo: ["agent:ops"] });
	await until(() => w.core.openDecisions("main").length >= 1, T);
	w.core.decide("main", w.core.openDecisions("main")[0].id, "human:anna", "reject", "no, keep it");
	await until(() => agentMsgs(w.core, "agent:ops").some((m: any) => m.status === "done"), T);
	const r = agentMsgs(w.core, "agent:ops")[0];
	obs("1c answer", r.text);
	assert.equal((w.core.db.prepare("SELECT COUNT(*) n FROM decisions").get() as any).n, 1, "did not ask again after a rejection");
	assert.match(r.text, /reject|not approved|declin|denied|won't|will not|did not/i);
	await w.close();
});

test("1d. ask_agent with a real model: delegation message, the other agent answers", { skip: !live, timeout: T }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", {
		text: "@ops checkout-api is crash-looping because POOL_SIZE is 0. Hand this to the developer with ask_agent (self-contained request), then tell me you did.", dispatchTo: ["agent:ops"],
	});
	await until(() => agentMsgs(w.core, "agent:developer").some((m: any) => m.status === "done") && agentMsgs(w.core, "agent:ops").some((m: any) => m.status === "done"), T);
	const del = thread(w.core).filter((m: any) => m.kind === "delegation");
	obs("1d delegations", del.map((m: any) => ({ from: m.authorId, to: m.meta.to, text: m.text.slice(0, 120) })));
	obs("1d ops", agentMsgs(w.core, "agent:ops")[0].text);
	obs("1d developer", agentMsgs(w.core, "agent:developer")[0].text.slice(0, 300));
	assert.equal(del[0].authorId, "agent:ops");
	assert.equal(del[0].meta.to, "developer", "the first hand-over is the one that was asked for");
	await until(() => w.core.trusted.workingMessages().length === 0 && w.core.trusted.pendingOutbox().length === 0 && w.pump.idle().constructor === Promise, 100_000);
	await w.pump.idle();
	assert.equal(w.core.trusted.workingMessages().length, 0, "the chain ended on its own");
	const perRun = new Map<string, number>();
	for (const e of w.core.events("main").filter((x) => x.type === "delegation.requested")) perRun.set(String(e.data.runId), (perRun.get(String(e.data.runId)) ?? 0) + 1);
	obs("1d delegations per run", [...perRun.values()]);
	assert.ok([...perRun.values()].every((n) => n <= 2), "no run fanned out beyond the per-run limit");
	assert.ok(del.length <= 6, `the whole chain stayed small (${del.length})`);
	await w.close();
});

test("1e. an image to a text-only model is refused out loud", { skip: !live, timeout: T }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops what does the attached screenshot show?", dispatchTo: ["agent:ops"], meta: { images: [{ name: "grafana.png", mime: "image/png" }] } });
	await until(() => agentMsgs(w.core, "agent:ops").some((m: any) => m.status === "done"), T);
	const notice = thread(w.core).find((m: any) => m.kind === "notice" && /NOT sent/.test(m.text));
	obs("1e notice", notice?.text ?? "(none)");
	obs("1e answer", agentMsgs(w.core, "agent:ops")[0].text);
	assert.ok(notice);
	assert.match(agentMsgs(w.core, "agent:ops")[0].text, /image|screenshot|see|text|describe/i);
	await w.close();
});
