import { test } from "node:test";
import assert from "node:assert/strict";
import { testCore } from "./helpers.ts";
import { FrontDesk, ROUTER_AGENTS, formatNotice, lacksContext, parseCorrection } from "../src/adapters/router/router.ts";
import { FakeClassifier, FakeClarifier } from "../src/adapters/router/fake.ts";
import { MemoryFeedback } from "../src/adapters/router/feedback.ts";
import {
	OpenRouterClassifier, OpenRouterClarifier, RouterModelError,
	classifierSystemPrompt, DEFAULT_CLASSIFIER_MODEL, DEFAULT_CLARIFIER_MODEL,
} from "../src/adapters/router/openrouter.ts";
import type { Classifier } from "../src/adapters/router/ports.ts";

/** A realm with the four router agents in one standing channel plus an operator human. */
function frontDeskWorld() {
	const t = testCore();
	const { core } = t;
	core.createRealm({ id: "acme", name: "Acme", kind: "team" });
	for (const h of ["ops", "developer", "reviewer", "insight"]) {
		core.addActor("acme", { id: `agent:${h}`, kind: "agent", name: h }, "system");
	}
	core.addActor("acme", { id: "human:anni", kind: "human", name: "Anni", roles: ["operator"] }, "system");
	core.createSpace("acme", { id: "front", kind: "standing", name: "front", agentIds: ["agent:ops", "agent:developer", "agent:reviewer", "agent:insight"] }, "system");
	const desk = (classifier: Classifier, extra: Partial<ConstructorParameters<typeof FrontDesk>[0]> = {}) =>
		new FrontDesk({ core, realmId: "acme", spaceId: "front", classifier, clarifier: new FakeClarifier(), ...extra });
	const posted = (kind?: string) => core.listMessages("acme", "front", "human:anni", 500).filter((m) => !kind || m.kind === kind);
	return { ...t, desk, posted };
}

const OPS_MSG = "checkout-api pod looping again in prod crashloopbackoff";
const DEV_MSG = "can someone fix the nullpointer in payments service order_processor.py line 45, it crashes if metadata is empty";

test("high confidence: routed to the agent with a visible routing line, clarifier not consulted", async () => {
	const w = frontDeskWorld();
	const classifier = new FakeClassifier();
	const clarifier = new FakeClarifier();
	const d = new FrontDesk({ core: w.core, realmId: "acme", spaceId: "front", classifier, clarifier });
	const human = w.core.postMessage("acme", "front", "human:anni", { text: OPS_MSG });
	const out = await d.handle({ text: OPS_MSG, by: "human:anni", messageId: human.message.id });
	assert.equal(out.kind, "routed");
	assert.equal(out.kind === "routed" && out.agent, "ops");
	assert.equal(clarifier.calls, 0, "no clarification cascade for a self-contained high-confidence message");
	const notices = w.posted("notice").map((m) => m.text);
	assert.ok(notices.some((t) => t === formatNotice("ops", (out as { confidence: number }).confidence)), `channel shows "-> @ops (x.xx)": ${JSON.stringify(notices)}`);
	const outbox = w.core.trusted.pendingOutbox();
	assert.ok(outbox.some((o) => o.agentId === "agent:ops"), "the agent is woken through the outbox");
});

test("@-mentions pass through: the normal path handles them, the desk does nothing", async () => {
	const w = frontDeskWorld();
	const before = w.posted().length;
	const out = await w.desk(new FakeClassifier()).handle({ text: "@ops restart it", by: "human:anni", messageId: 999 });
	assert.equal(out.kind, "passed");
	assert.equal(w.posted().length, before, "no side effects");
});

test("low confidence / two suitable: a human picks (decision + attention, same model as decisions)", async () => {
	const w = frontDeskWorld();
	const vague: Classifier = { classify: async () => ({ agent: "ops", confidence: 0.4 }) };
	const d = new FrontDesk({ core: w.core, realmId: "acme", spaceId: "front", classifier: vague });
	const out = await d.handle({ text: "something is off, also the build thing", by: "human:anni", messageId: 7 });
	assert.equal(out.kind, "needs-human");
	const decisions = w.core.openDecisions("acme");
	assert.equal(decisions.length, 1, "one decision card");
	assert.deepEqual([...decisions[0].options].sort(), ["developer", "insight", "none", "ops", "reviewer"]);
	const attention = w.core.openAttention("acme");
	assert.ok(attention.some((a) => a.kind === "decision"), "an attention item like any other decision");
});

test('"none" with high confidence: a polite reply, nobody woken', async () => {
	const w = frontDeskWorld();
	const out = await w.desk(new FakeClassifier()).handle({ text: "thx guys fix for PAY-881 works in staging now, heading to lunch", by: "human:anni", messageId: 11 });
	assert.equal(out.kind, "none");
	assert.equal(w.core.trusted.pendingOutbox().length, 0, "no agent woken");
	const last = w.posted().at(-1)!;
	assert.match(last.text, /leave it for the humans/i);
});

test("a model that returns garbage falls back to a human choice, never a silent drop", async () => {
	const w = frontDeskWorld();
	const garbage: Classifier = { classify: async () => ({ agent: "kubernetes-demon", confidence: 0.99 }) };
	const out = await w.desk(garbage).handle({ text: OPS_MSG, by: "human:anni", messageId: 21 });
	assert.equal(out.kind, "needs-human");
	assert.equal(w.core.openDecisions("acme").length, 1, "the message is visible as a decision, not lost");
});

test("a throwing model and a timeout both fall back to a human choice", async () => {
	const w = frontDeskWorld();
	const boom: Classifier = { classify: async () => { throw new Error("500 upstream"); } };
	const out1 = await w.desk(boom).handle({ text: OPS_MSG, by: "human:anni", messageId: 31 });
	assert.equal(out1.kind, "needs-human");
	const slow: Classifier = { classify: async () => { await new Promise((r) => setTimeout(r, 500)); return { agent: "ops", confidence: 0.99 }; } };
	const d = new FrontDesk({ core: w.core, realmId: "acme", spaceId: "front", classifier: slow, classifyTimeoutMs: 20 });
	const out2 = await d.handle({ text: OPS_MSG, by: "human:anni", messageId: 32 });
	assert.equal(out2.kind, "needs-human");
	assert.equal(w.core.openDecisions("acme").length, 2, "both failures are visible, none silent");
});

test("a model that returns invalid JSON shape falls back to a human choice", async () => {
	const w = frontDeskWorld();
	const weird = { classify: async () => ({ agent: "", confidence: Number.NaN }) } as unknown as Classifier;
	const out = await w.desk(weird).handle({ text: OPS_MSG, by: "human:anni", messageId: 33 });
	assert.equal(out.kind, "needs-human");
});

test("messy message with no context: one clarifying question, then the answer routes", async () => {
	const w = frontDeskWorld();
	const classifier = new FakeClassifier();
	const clarifier = new FakeClarifier();
	const d = new FrontDesk({ core: w.core, realmId: "acme", spaceId: "front", classifier, clarifier });
	const out = await d.handle({ text: "fix it", by: "human:anni", messageId: 41 });
	assert.equal(out.kind, "clarify");
	assert.equal(clarifier.calls, 1);
	const last = w.posted().at(-1)!;
	assert.match(last.text, /which service/i);
	assert.equal(w.core.trusted.pendingOutbox().length, 0, "nothing routed before the human answers");
});

test('human correction ("ei, developer") is stored and re-routed', async () => {
	const w = frontDeskWorld();
	const feedback = new MemoryFeedback();
	const d = new FrontDesk({ core: w.core, realmId: "acme", spaceId: "front", classifier: new FakeClassifier(), clarifier: new FakeClarifier(), feedback });
	const human = w.core.postMessage("acme", "front", "human:anni", { text: OPS_MSG });
	const routed = await d.handle({ text: OPS_MSG, by: "human:anni", messageId: human.message.id });
	assert.equal(routed.kind, "routed");
	const fix = await d.correct({ text: "ei, developer", by: "human:anni", messageId: human.message.id });
	assert.ok(fix && fix.kind === "routed" && fix.agent === "developer");
	assert.equal(feedback.corrections.length, 1);
	assert.deepEqual([feedback.corrections[0].routedTo, feedback.corrections[0].correctedTo], ["ops", "developer"]);
	const notices = w.posted("notice").map((m) => m.text);
	assert.ok(notices.some((t) => /correction/.test(t)));
	const notCorrection = await d.correct({ text: "looks good, thanks!", by: "human:anni" });
	assert.equal(notCorrection, null);
	assert.equal(feedback.corrections.length, 1, "plain chat is not stored as a correction");
});

test("handling is idempotent per message: a retry posts nothing twice", async () => {
	const w = frontDeskWorld();
	const d = w.desk(new FakeClassifier());
	const human = w.core.postMessage("acme", "front", "human:anni", { text: DEV_MSG });
	const first = await d.handle({ text: DEV_MSG, by: "human:anni", messageId: human.message.id });
	const n = w.posted().length;
	const second = await d.handle({ text: DEV_MSG, by: "human:anni", messageId: human.message.id });
	assert.equal(first.kind, "routed");
	assert.equal(second.kind, "routed");
	assert.equal(w.posted().length, n, "no duplicate notices or dispatches");
});

test("lacksContext: cascade only when the message cannot stand alone", () => {
	assert.equal(lacksContext("checkout-api pod looping again in prod crashloopbackoff"), false);
	assert.equal(lacksContext("can someone check pr 412 in payments-service? tests pass need approval"), false);
	assert.equal(lacksContext("fix it"), true);
	assert.equal(lacksContext("se kaatuu taas"), true);
	assert.equal(lacksContext("moi, mitä kuuluu?"), false, "small talk is answerable (none), not unclear");
	assert.equal(lacksContext(""), true);
});

test("parseCorrection understands the human override forms", () => {
	assert.equal(parseCorrection("ei, developer", ROUTER_AGENTS), "developer");
	assert.equal(parseCorrection("No, @ops", ROUTER_AGENTS), "ops");
	assert.equal(parseCorrection("väärin, reviewer!", ROUTER_AGENTS), "reviewer");
	assert.equal(parseCorrection("ei kun insight", ROUTER_AGENTS), "insight");
	assert.equal(parseCorrection("looks good", ROUTER_AGENTS), null);
	assert.equal(parseCorrection("ei, kubernetes", ROUTER_AGENTS), null);
});

// ------------------------------------------------------------------ OpenRouter adapter (stub fetch, still offline)

const chatOk = (content: string, cost: number | null = 0.0001) =>
	async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost } }), { status: 200 });

test("OpenRouter classifier: json_object, max_tokens >= 2000, parses agent + confidence", async () => {
	let body: any;
	const stub = async (_url: unknown, init: any) => {
		body = JSON.parse(init.body);
		return chatOk('{"agent":"ops","confidence":0.92}')();
	};
	const c = new OpenRouterClassifier({ apiKey: "test-key", fetchImpl: stub as typeof fetch });
	assert.equal(c.model, DEFAULT_CLASSIFIER_MODEL);
	const r = await c.classify(OPS_MSG, ROUTER_AGENTS);
	assert.deepEqual(r, { agent: "ops", confidence: 0.92 });
	assert.deepEqual(body.response_format, { type: "json_object" });
	assert.ok(body.max_tokens >= 2000, `max_tokens ${body.max_tokens} (reasoning models starve below this)`);
	assert.equal(body.temperature, 0);
	assert.ok(String(body.messages[0].content).includes("- ops:"), "the role list travels in the system prompt");
	assert.ok(classifierSystemPrompt(ROUTER_AGENTS).includes("Review-intent wins"), "review-intent disambiguation is in the canonical prompt (scripts/router-live.mjs keeps a byte-identical copy)");
});

test("OpenRouter classifier: HTTP errors, empty answers and garbage become RouterModelError (router falls back)", async () => {
	const http500 = new OpenRouterClassifier({ apiKey: "k", fetchImpl: (async () => new Response("busy", { status: 500 })) as typeof fetch });
	await assert.rejects(() => http500.classify("x", ROUTER_AGENTS), (e: unknown) => e instanceof RouterModelError && e.kind === "http");
	const empty = new OpenRouterClassifier({ apiKey: "k", fetchImpl: chatOk("   ") as typeof fetch });
	await assert.rejects(() => empty.classify("x", ROUTER_AGENTS), (e: unknown) => e instanceof RouterModelError && e.kind === "empty");
	const noJson = new OpenRouterClassifier({ apiKey: "k", fetchImpl: chatOk("sure, ops I guess") as typeof fetch });
	await assert.rejects(() => noJson.classify("x", ROUTER_AGENTS), (e: unknown) => e instanceof RouterModelError && e.kind === "parse");
	const unknownAgent = new OpenRouterClassifier({ apiKey: "k", fetchImpl: chatOk('{"agent":"dba","confidence":0.9}') as typeof fetch });
	await assert.rejects(() => unknownAgent.classify("x", ROUTER_AGENTS), (e: unknown) => e instanceof RouterModelError && e.kind === "parse");
	const slow = new OpenRouterClassifier({ apiKey: "k", timeoutMs: 20, fetchImpl: ((async (_u: unknown, init: any) => {
		await new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
		throw new Error("unreachable");
	}) as unknown) as typeof fetch });
	await assert.rejects(() => slow.classify("x", ROUTER_AGENTS), (e: unknown) => e instanceof RouterModelError && e.kind === "timeout");
});

test("OpenRouter clarifier: request vs question, default model", async () => {
	const req = new OpenRouterClarifier({ apiKey: "k", fetchImpl: chatOk('{"request":"checkout-api crashes in prod, investigate"}') as typeof fetch });
	assert.equal(req.model, DEFAULT_CLARIFIER_MODEL);
	assert.deepEqual(await req.clarify("se kaatuu", ROUTER_AGENTS), { kind: "clear", text: "checkout-api crashes in prod, investigate" });
	const q = new OpenRouterClarifier({ apiKey: "k", fetchImpl: chatOk('{"question":"Which service?"}') as typeof fetch });
	assert.deepEqual(await q.clarify("fix it", ROUTER_AGENTS), { kind: "question", question: "Which service?" });
	const junk = new OpenRouterClarifier({ apiKey: "k", fetchImpl: chatOk('{"hmm":"maybe"}') as typeof fetch });
	await assert.rejects(() => junk.clarify("fix it", ROUTER_AGENTS), (e: unknown) => e instanceof RouterModelError);
});
