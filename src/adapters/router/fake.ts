// experimental: front desk router Fake (off unless ENTROPI_EXPERIMENTAL_ROUTER=1).
import type { AgentDesc, Classification, Clarifier, Classifier, ClarifyResult } from "./ports.ts";
import { isSmallTalk } from "./router.ts";

/**
 * Deterministic keyword classifiers for tests and offline simulations. No network, no clock tricks: the same
 * message always yields the same answer. Tuned against test/router/fixtures/set.json, but deliberately simple:
 * clear cases classify high, ambiguous/multi ones land low so the router asks a human.
 */

type Weighted = [pattern: RegExp, weight: number];

const OPS: Weighted[] = [
	[/crashloop/i, 3], [/oomkill/i, 3], [/liveness/i, 3], [/diskpressure/i, 3], [/\bpod\b/i, 2], [/\bpods\b/i, 2],
	[/ingress/i, 3], [/roll\s?out/i, 3], [/got approved/i, 2], [/restart/i, 2], [/evict/i, 2], [/drain/i, 2],
	[/tainted/i, 2], [/upstream/i, 2], [/heap dump/i, 2], [/jumissa/i, 2], [/\btls\b/i, 2], [/cert/i, 2],
	[/replica/i, 2], [/\balert\b/i, 2], [/firing/i, 2], [/helm/i, 2], [/cluster/i, 2], [/gateway/i, 2],
	[/lokit?/i, 2], [/\blogs?\b/i, 2], [/\b502\b/, 2], [/\b504\b/, 2], [/probe/i, 2],
	[/pending/i, 1], [/pystyyn/i, 1], [/\bprod\b/i, 2], [/tuotanto/i, 2], [/produn/i, 2], [/staging/i, 1],
	[/\b500\b/, 1], [/\b404\b/, 1], [/timeout/i, 1], [/kaatuu|kaadu/i, 1], [/kuoli/i, 1], [/expired/i, 1],
	[/\bnode\b/i, 1], [/viive/i, 1], [/deploy/i, 0],
];

const DEVELOPER: Weighted[] = [
	[/unit tests?/i, 2], [/write/i, 1], [/nullpointer/i, 2], [/endpoint/i, 2], [/patch/i, 2],
	[/\bfix\b/i, 1], [/koodaa/i, 2], [/koodimuuto/i, 2], [/korjau/i, 2], [/fiks/i, 2], [/pikafiksi/i, 2],
	[/refactor/i, 2], [/migration|migraatio/i, 2], [/entity/i, 2], [/\bbump\b/i, 2], [/redis-py/i, 2],
	[/voucher/i, 2], [/discount/i, 2], [/\bjwt\b/i, 2], [/\bcve\b/i, 2], [/connection pool/i, 2],
	[/mock/i, 2], [/fixture/i, 2], [/go test/i, 2], [/\bn\+1\b/i, 2], [/syncitems/i, 2], [/\bsku\b/i, 2],
	[/stripe/i, 1], [/webhook/i, 1], [/sendgrid/i, 1], [/refund/i, 1], [/ticket\s+[A-Z]+-\d+|[A-Z]+-\d+/i, 1],
	[/branch/i, 0],
];

const REVIEWER: Weighted[] = [
	[/\bpr\b/i, 2], [/\blgtm\b/i, 3], [/signoff/i, 3], [/ptal/i, 3], [/pair of eyes/i, 3],
	[/approv/i, 2], [/hyväksyntä/i, 2], [/leimaa/i, 2], [/katselmo/i, 2], [/arvioitava/i, 2],
	[/sanity check/i, 2], [/\bdiff\b/i, 2], [/code review/i, 1], [/\bmerge/i, 1], [/branch/i, 1],
	[/deploy/i, 1], [/ready/i, 1], [/järkevältä/i, 1],
];

const INSIGHT: Weighted[] = [
	[/kuvaaja/i, 3], [/käppyr/i, 3], [/graaf/i, 2], [/chart/i, 3], [/throughput/i, 2],
	[/breakdown/i, 2], [/trend/i, 2], [/konversio/i, 2], [/conversion/i, 2], [/retention/i, 2],
	[/churn/i, 2], [/anomal/i, 2], [/poikkeava/i, 2], [/latenss/i, 2], [/latency/i, 2],
	[/\bp9[05]\b/i, 2], [/\bqps\b/i, 2], [/response time/i, 2], [/cohort/i, 2], [/skaalaut/i, 2],
	[/traffic/i, 1], [/pattern/i, 1], [/\bdip\b/i, 1], [/spike/i, 1], [/piikki/i, 1],
	[/metric/i, 1], [/korrela|correla/i, 1], [/degraded/i, 1], [/analyysi/i, 1], [/volyymi/i, 1],
	[/vertailu|compar/i, 1], [/lineaar/i, 1], [/utilis/i, 1], [/raportti/i, 1],
];

const SMALLTALK: Weighted[] = [
	[/kiitti|kiitos|thanks|\bthx\b/i, 3], [/louna/i, 3], [/\blunch\b/i, 3], [/kahvi|pannu/i, 3],
	[/\bcoffee\b/i, 3], [/\bafk\b/i, 3], [/\bretro\b/i, 2], [/sprint planning/i, 2], [/kalenteri/i, 2],
	[/kokous|meeting/i, 2], [/google meet/i, 2], [/\bjoin\b/i, 1], [/\bbot\b/i, 2], [/huomenta/i, 2],
	[/maanantai/i, 2], [/sade|raining|raining|cycling/i, 2], [/\blol\b|haha/i, 1], [/laptop|\bm3\b/i, 2],
	[/mitä kuuluu/i, 2], [/theme|taste/i, 2], [/\bhr\b|pekkaspäiv/i, 2], [/saikulla/i, 1],
	[/huomiselle|siirret/i, 1],
];

const score = (text: string, rules: Weighted[]): number => {
	let s = 0;
	for (const [re, w] of rules) if (re.test(text)) s += w;
	return s;
};

export function fakeScores(text: string): Record<string, number> {
	return { ops: score(text, OPS), developer: score(text, DEVELOPER), reviewer: score(text, REVIEWER), insight: score(text, INSIGHT) };
}

export class FakeClassifier implements Classifier {
	calls = 0;
	async classify(message: string, agents: AgentDesc[]): Promise<Classification> {
		this.calls++;
		const handles = new Set(agents.map((a) => a.handle.toLowerCase()));
		const small = isSmallTalk(message) ? 3 : score(message, SMALLTALK);
		const s = fakeScores(message);
		const ranked = Object.entries(s).filter(([h]) => handles.has(h)).sort((a, b) => b[1] - a[1]);
		const [[top, s1], [, s2 = 0] = []] = [ranked[0] ?? ["none", 0], ranked[1] ?? ["none", 0]] as [[string, number], [string, number] | undefined];
		if (small >= 2 && small >= s1) return { agent: "none", confidence: 0.95 };
		if (s1 <= 0) return { agent: "none", confidence: 0.55 };
		return { agent: top, confidence: s1 / (s1 + 0.5 * (s2 ?? 0) + 1) };
	}
}

/** Deterministic clarifier: small talk and self-contained messages pass through, the rest get one question. */
export class FakeClarifier implements Clarifier {
	calls = 0;
	async clarify(message: string, _agents: AgentDesc[]): Promise<ClarifyResult> {
		this.calls++;
		const t = message.trim().replace(/\s+/g, " ");
		if (isSmallTalk(t) || score(t, SMALLTALK) >= 2) return { kind: "clear", text: t };
		const s = fakeScores(t);
		const substance = Object.values(s).some((v) => v > 0) || /(api|pod|service|pr|branch|chart|kuvaaja|koodi|config|db|maksu|payment|checkout|ticket|[A-Z]+-\d+|#\d+|error|test|data)/i.test(t);
		if (t.length >= 30 && substance) return { kind: "clear", text: t };
		return {
			kind: "question",
			question: "Mikä palvelu, branch/PR tai mittari on kyseessä ja mitä pitäisi tehdä? / Which service, branch/PR or metric is this about, and what should be done?",
		};
	}
}
