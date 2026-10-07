import type { AgentDesc, Classifier } from "./ports.ts";

/**
 * Offline simulation harness: same dataset, same metrics, for Fake and live classifiers.
 * Accuracy + confusion matrix, latency p50/p95, cost. Multi-step messages (two agents in one)
 * are reported separately: routing to the FIRST agent is correct there, the rest is ask_agent's job.
 */

export type SimItem = { msg: string; exp: string };
export type SimPrediction = { predicted: string; confidence: number; ms: number; cost: number | null };

/** Two strong signals in one message (investigate + fix, analyse + patch...): first agent starts. */
export function isMulti(text: string): boolean {
	const investigate = /(tutki|tsekkaa|check|selvitä|analyysi|chart|kuvaaja|käppyr|review|katselmo|logi|metrics|pod)/i.test(text);
	const build = /(koodaa|fix|patch|korjaa|fiksi|branch|testit|refaktoroi|dev\b|merge|review|arvio|rollout|config|flag)/i.test(text);
	return investigate && build && text.length > 80;
}

export type Confusion = { labels: string[]; matrix: Record<string, Record<string, number>>; accuracy: number; n: number };

export function confusionMatrix(expected: string[], predicted: string[]): Confusion {
	const labels = [...new Set([...expected, ...predicted])].sort();
	const matrix: Record<string, Record<string, number>> = {};
	for (const e of labels) {
		matrix[e] = {};
		for (const p of labels) matrix[e][p] = 0;
	}
	let ok = 0;
	for (let i = 0; i < expected.length; i++) {
		matrix[expected[i]][predicted[i]]++;
		if (expected[i] === predicted[i]) ok++;
	}
	return { labels, matrix, accuracy: expected.length ? ok / expected.length : 0, n: expected.length };
}

export function percentile(sortedMs: number[], p: number): number {
	if (sortedMs.length === 0) return 0;
	const s = [...sortedMs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export type SimReport = {
	n: number;
	accuracy: number;
	p50: number;
	p95: number;
	cost: number;
	unknownCost: number;
	confusion: Confusion;
	multi: { n: number; firstAgentHit: number };
	lowConfidence: number;
	rows: { msg: string; exp: string; predicted: string; confidence: number; ms: number }[];
};

export async function runSimulation(o: {
	items: SimItem[];
	classify: (msg: string) => Promise<{ agent: string; confidence: number; cost?: number | null }>;
	agents?: AgentDesc[];
	threshold?: number;
	onProgress?: (done: number, total: number) => void;
}): Promise<SimReport> {
	const threshold = o.threshold ?? 0.7;
	const rows: SimReport["rows"] = [];
	const expected: string[] = [];
	const predicted: string[] = [];
	const lat: number[] = [];
	let cost = 0, unknownCost = 0, low = 0, multiN = 0, multiHit = 0;
	let i = 0;
	for (const item of o.items) {
		const t = Date.now();
		const r = await o.classify(item.msg);
		const ms = Date.now() - t;
		// Same safety rule as the router: an unknown agent is never routed, it becomes a human choice.
		const known = !o.agents || r.agent === "none" || o.agents.some((a) => a.handle.toLowerCase() === r.agent.toLowerCase());
		const pred = r.confidence >= threshold && known ? r.agent : "HUMAN";
		rows.push({ msg: item.msg, exp: item.exp, predicted: pred, confidence: r.confidence, ms });
		expected.push(item.exp);
		predicted.push(pred);
		lat.push(ms);
		if (r.cost != null) cost += r.cost;
		else unknownCost++;
		if (r.confidence < threshold) low++;
		if (isMulti(item.msg)) {
			multiN++;
			if (pred === item.exp || pred === "HUMAN") multiHit++;
		}
		if (++i % 10 === 0) o.onProgress?.(i, o.items.length);
	}
	o.onProgress?.(i, o.items.length);
	return {
		n: o.items.length, accuracy: confusionMatrix(expected, predicted).accuracy,
		p50: percentile(lat, 50), p95: percentile(lat, 95), cost, unknownCost,
		confusion: confusionMatrix(expected, predicted),
		multi: { n: multiN, firstAgentHit: multiHit }, lowConfidence: low, rows,
	};
}

export function formatConfusion(c: Confusion): string {
	const head = `      pred> ${c.labels.map((l) => l.padEnd(9)).join(" ")}`;
	const lines = c.labels.map((e) => `exp ${e.padEnd(5)} ${c.labels.map((p) => String(c.matrix[e][p]).padEnd(9)).join(" ")}`);
	return [head, ...lines].join("\n");
}

/** Wrap a Classifier port into the simulation's classify function (cost unknown offline). */
export const portClassify = (c: Classifier, agents: AgentDesc[]) => async (msg: string) => {
	const r = await c.classify(msg, agents);
	return { agent: r.agent, confidence: r.confidence, cost: null as number | null };
};
