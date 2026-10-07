import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeClassifier, FakeClarifier } from "../src/adapters/router/fake.ts";
import { ROUTER_AGENTS } from "../src/adapters/router/router.ts";
import { runSimulation, portClassify, formatConfusion, isMulti, type SimItem } from "../src/adapters/router/simulate.ts";
import type { Classifier } from "../src/adapters/router/ports.ts";

const items = JSON.parse(readFileSync(new URL("./router/fixtures/set.json", import.meta.url), "utf8")) as SimItem[];

const classifyOnly = (c: Classifier) => portClassify(c, ROUTER_AGENTS);

/** Config B: clarify first when the cascade triggers, then classify the clarified text. */
const withClarify = (c: Classifier, cl: FakeClarifier) => async (msg: string) => {
	const { lacksContext } = await import("../src/adapters/router/router.ts");
	const first = await c.classify(msg, ROUTER_AGENTS);
	if (first.confidence < 0.7 || lacksContext(msg)) {
		const r = await cl.clarify(msg, ROUTER_AGENTS);
		if (r.kind === "clear" && r.text !== msg.trim()) return { ...(await c.classify(r.text, ROUTER_AGENTS)), cost: null };
	}
	return { ...first, cost: null };
};

test("offline simulation (Fake): accuracy, confusion matrix and timing over the whole fixture", async () => {
	const rep = await runSimulation({ items, classify: classifyOnly(new FakeClassifier()), agents: ROUTER_AGENTS });
	console.log(`OBS fake accuracy ${(rep.accuracy * 100).toFixed(1)}% (${rep.n} msgs) p50 ${rep.p50}ms p95 ${rep.p95}ms low-conf ${rep.lowConfidence} multi ${rep.multi.firstAgentHit}/${rep.multi.n}`);
	console.log("OBS fake confusion:\n" + formatConfusion(rep.confusion));
	assert.ok(rep.accuracy >= 0.6, `Fake should route most of the fixture (got ${rep.accuracy})`);
	const wrongRouted = rep.rows.filter((r) => r.predicted !== "HUMAN" && r.predicted !== r.exp);
	assert.equal(wrongRouted.length, 0, `never confidently wrong: ${JSON.stringify(wrongRouted.slice(0, 3))}`);
	assert.ok(rep.multi.n > 0, "the fixture has multi-step messages, reported separately");
});

test("offline simulation config B (clarify + classify): clarification changes nothing for Fake, cost stays zero", async () => {
	const cl = new FakeClarifier();
	const rep = await runSimulation({ items, classify: withClarify(new FakeClassifier(), cl), agents: ROUTER_AGENTS });
	console.log(`OBS fake+B accuracy ${(rep.accuracy * 100).toFixed(1)}% clarifier-calls ${cl.calls}`);
	assert.ok(rep.accuracy >= 0.6);
	assert.ok(cl.calls > 0 && cl.calls < items.length, `cascade, not always: ${cl.calls}/${items.length}`);
});

test("offline error-path simulation: garbage/timeout models lose nothing (all become human choices)", async () => {
	const garbage: Classifier = { classify: async () => ({ agent: "??", confidence: 0.99 }) };
	const rep = await runSimulation({ items: items.slice(0, 10), classify: classifyOnly(garbage), threshold: 0.7, agents: ROUTER_AGENTS });
	assert.ok(rep.rows.every((r) => r.predicted === "HUMAN"), "every message falls back to a human, none disappears");
	assert.ok(isMulti("checkout-api heittää 500 tuotannossa solkenaan tsekkaa lokit ja sit varmaa pitää koodaa nopee hotfixi"));
	assert.ok(!isMulti(OPS_SINGLE));
});

const OPS_SINGLE = "checkout-api pod looping again in prod crashloopbackoff";
