// Live router evaluation: config A (classifier only) vs config B (clarify + classify) on the same
// fixture, plus a garbage probe. Needs ~/openrouter20usd.key at runtime; without it prints SKIP and
// exits 0 (npm test never touches the network). The key is only ever sent as an Authorization header:
// never printed, logged or stored.
//
// Canonical prompts live in src/adapters/router/openrouter.ts (classifierSystemPrompt /
// clarifierSystemPrompt); the copies below are kept byte-identical on purpose. Usage:
//   npm run test:router-live [-- --limit=20 --classifier-model=amazon/nova-micro-v1
//     --clarifier-model=inception/mercury-2.5 --concurrency=4]
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = /^--([^=]+)=(.*)$/.exec(a);
	return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
}));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CLASSIFIER_MODEL = args["classifier-model"] ?? process.env.ROUTER_CLASSIFIER_MODEL ?? "amazon/nova-micro-v1";
const CLARIFIER_MODEL = args["clarifier-model"] ?? process.env.ROUTER_CLARIFIER_MODEL ?? "inception/mercury-2.5";
const CONCURRENCY = Number(args.concurrency ?? 4);
const THRESHOLD = 0.7;

const AGENTS = [
	["ops", "Investigates live systems: pods, logs, crash loops, restarts, metrics. Applies approved config changes."],
	["developer", "Writes and fixes code in a sandbox, runs tests, prepares branches and patches."],
	["reviewer", "Reviews changes and branches, approves or rejects with reasons. Does not write code."],
	["insight", "Analyses data and metrics, makes charts, explains anomalies and trends."],
];
const HANDLES = new Set(AGENTS.map(([h]) => h));

// Byte-identical to src/adapters/router/openrouter.ts (see header).
const classifierSystem = `You route chat messages to exactly one agent, or none. Agents:\n${AGENTS.map(([h, d]) => `- ${h}: ${d}`).join("\n")}\nIf the message is small talk or fits no agent, answer "none". Review-intent wins: if the message asks someone to look at, review, approve, sign off or merge a PR, pull, branch or diff, answer "reviewer" even when code or ops words appear. Reply with ONLY JSON: {"agent":"<handle|none>","confidence":<0..1>}`;
const clarifierSystem = `You clarify messy chat messages for a router. Handles: ${AGENTS.map(([h]) => h).join(", ")}.\nIf the message is self-contained, reply with ONLY JSON: {"request":"<standalone request with names/ids kept>"}. If essential context is missing, reply with ONLY JSON: {"question":"<one short clarifying question>"}. Small talk needs no clarification: echo it back as {"request":"<the message>"}.`;

// Mirrors lacksContext/isSmallTalk in src/adapters/router/router.ts.
const SMALLTALK_RE = /kiitti|kiitos|thanks|\bthx\b|louna|\blunch\b|kahvi|pannu|\bcoffee\b|\bafk\b|\bretro\b|sprint planning|kalenteri|kokous|meeting|google meet|\bjoin\b|\bbot\b|huomenta|maanantai|sade|raining|cycling|\blol\b|haha|laptop|\bm3\b|mitä kuuluu|theme|taste|\bhr\b|pekkaspäiv|saikulla|huomiselle|siirret/i;
function lacksContext(text) {
	const t = text.trim();
	if (!t) return true;
	if (SMALLTALK_RE.test(t)) return false;
	if (/^(se|tämä|tää|toi|tuo|ne|it|this|that|these|those|fix it|do it|katso|tsekkaa)\W*$/i.test(t)) return true;
	if (t.length < 30) {
		const substance = /(api|pod|service|pr\b|branch|chart|kuvaaja|käppyr|koodi|config|db|maksu|payment|checkout|ticket|[A-Z]+-\d+|#\d+|error|test|data|loki|logi|muisti|kuorma)/i.test(t);
		if (!substance) return true;
		if (/(^|\W)(se|tämä|tää|toi|tuo|ne|it|this|that)\b/i.test(t)) return true;
	}
	return false;
}

const keyPath = join(homedir(), "openrouter20usd.key");
// experimental: the live eval stays off unless the flag arms it (npm test never reaches the key file).
if (process.env.ENTROPI_EXPERIMENTAL_ROUTER !== "1") {
	console.log("SKIP: experimental router is off (set ENTROPI_EXPERIMENTAL_ROUTER=1 to run the live router eval; npm test stays offline)");
	process.exit(0);
}
if (!existsSync(keyPath)) {
	console.log("SKIP: no key file at ~/openrouter20usd.key (live router eval needs it; npm test stays offline)");
	process.exit(0);
}
const KEY = readFileSync(keyPath, "utf8").trim();
if (!KEY) {
	console.log("SKIP: empty key file");
	process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const allItems = JSON.parse(readFileSync(join(root, "..", "test", "router", "fixtures", "set.json"), "utf8"));
const items = allItems.slice(0, LIMIT);
console.log(`router-live: ${items.length}/${allItems.length} msgs, classifier=${CLASSIFIER_MODEL} clarifier=${CLARIFIER_MODEL}`);

async function chat({ model, system, user, maxTokens = 2500 }) {
	const t = Date.now();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 60_000);
	try {
		const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST", signal: ctrl.signal,
			headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "HTTP-Referer": "entropi-router", "X-Title": "entropi-router" },
			body: JSON.stringify({ model, temperature: 0, max_tokens: Math.max(maxTokens, 8), response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
		});
		if (!r.ok) return { error: `http ${r.status}`, ms: Date.now() - t, cost: null };
		const j = await r.json();
		const text = j.choices?.[0]?.message?.content ?? "";
		const cost = typeof j.usage?.cost === "number" ? j.usage.cost : null;
		return { text, ms: Date.now() - t, cost };
	} catch (e) {
		return { error: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t, cost: null };
	} finally {
		clearTimeout(timer);
	}
}

function parseClassify(text) {
	const m = String(text ?? "").match(/\{[\s\S]*\}/);
	if (!m) return { error: "no-json" };
	try {
		const o = JSON.parse(m[0]);
		const agent = String(o.agent ?? "").toLowerCase().replace(/^@/, "");
		const conf = Math.min(1, Math.max(0, Number(o.confidence)));
		if ((!HANDLES.has(agent) && agent !== "none") || !Number.isFinite(conf)) return { error: "unusable" };
		return { agent, confidence: conf };
	} catch {
		return { error: "bad-json" };
	}
}

async function classifyA(msg) {
	const r = await chat({ model: CLASSIFIER_MODEL, system: classifierSystem, user: msg });
	if (r.error || !r.text) return { predicted: "HUMAN", why: r.error ?? "empty", ms: r.ms, cost: r.cost, calls: 1 };
	const p = parseClassify(r.text);
	if (p.error) return { predicted: "HUMAN", why: p.error, ms: r.ms, cost: r.cost, calls: 1 };
	return { predicted: p.confidence >= THRESHOLD ? p.agent : "HUMAN", why: `${p.agent}/${p.confidence.toFixed(2)}`, ms: r.ms, cost: r.cost, calls: 1 };
}

async function classifyB(msg) {
	// Cascade: clarify only on low confidence or missing context.
	const first = await chat({ model: CLASSIFIER_MODEL, system: classifierSystem, user: msg });
	let ms = first.ms, cost = first.cost ?? 0, calls = 1, clarifies = 0;
	if (first.error || !first.text) return { predicted: "HUMAN", why: first.error ?? "empty", ms, cost, calls };
	const p1 = parseClassify(first.text);
	if (p1.error) return { predicted: "HUMAN", why: p1.error, ms, cost, calls };
	if (p1.confidence >= THRESHOLD && !lacksContext(msg)) {
		return { predicted: p1.agent, why: `${p1.agent}/${p1.confidence.toFixed(2)}`, ms, cost, calls };
	}
	const cl = await chat({ model: CLARIFIER_MODEL, system: clarifierSystem, user: msg });
	ms += cl.ms; cost += cl.cost ?? 0; calls++; clarifies++;
	if (cl.error || !cl.text) return { predicted: "HUMAN", why: `clarify:${cl.error ?? "empty"}`, ms, cost, calls, clarifies };
	let req = null, question = null;
	try {
		const o = JSON.parse(cl.text.match(/\{[\s\S]*\}/)[0]);
		if (typeof o.question === "string" && o.question.trim()) question = o.question.trim();
		else if (typeof o.request === "string" && o.request.trim()) req = o.request.trim();
	} catch { /* fall through */ }
	if (question || !req) return { predicted: "HUMAN", why: question ? "clarify:question" : "clarify:unusable", ms, cost, calls, clarifies };
	const second = await chat({ model: CLASSIFIER_MODEL, system: classifierSystem, user: req });
	ms += second.ms; cost += second.cost ?? 0; calls++;
	if (second.error || !second.text) return { predicted: "HUMAN", why: second.error ?? "empty", ms, cost, calls, clarifies };
	const p2 = parseClassify(second.text);
	if (p2.error) return { predicted: "HUMAN", why: p2.error, ms, cost, calls, clarifies };
	return { predicted: p2.confidence >= THRESHOLD ? p2.agent : "HUMAN", why: `${p1.agent}/${p1.confidence.toFixed(2)}->${p2.agent}/${p2.confidence.toFixed(2)}`, ms, cost, calls, clarifies };
}

async function pool(fn, list) {
	const out = new Array(list.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
		while (next < list.length) {
			const i = next++;
			out[i] = await fn(list[i], i);
			if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${list.length}\r`);
		}
	}));
	process.stderr.write("\n");
	return out;
}

function report(name, items, results) {
	let ok = 0, human = 0, cost = 0, unknownCost = 0, ms = [], calls = 0, clarifies = 0;
	const labels = ["ops", "developer", "reviewer", "insight", "none", "HUMAN"];
	const matrix = Object.fromEntries(labels.map((e) => [e, Object.fromEntries(labels.map((p) => [p, 0]))]));
	const wrong = [];
	results.forEach((r, i) => {
		const exp = items[i].exp, pred = r.predicted;
		matrix[exp][pred]++;
		ms.push(r.ms);
		if (r.cost != null) cost += r.cost; else unknownCost++;
		calls += r.calls; clarifies += r.clarifies ?? 0;
		if (pred === exp) ok++;
		else if (pred === "HUMAN") human++;
		else wrong.push(`"${items[i].msg.slice(0, 70)}" want ${exp} got ${pred} (${r.why})`);
	});
	ms.sort((a, b) => a - b);
	const p = (q) => ms.length ? ms[Math.min(ms.length - 1, Math.floor((q / 100) * ms.length))] : 0;
	console.log(`\n== ${name}: ${ok}/${items.length} exact, ${human} human, ${wrong.length} wrong | p50 ${p(50)}ms p95 ${p(95)}ms | ${calls} calls (${clarifies} clarifies) | cost $${cost.toFixed(5)}${unknownCost ? ` (+${unknownCost} unknown-cost)` : ""}`);
	console.log(`      pred> ${labels.map((l) => l.padEnd(9)).join(" ")}`);
	for (const e of labels) console.log(`exp ${e.padEnd(5)} ${labels.map((x) => String(matrix[e][x]).padEnd(9)).join(" ")}`);
	for (const w of wrong.slice(0, 25)) console.log("   X", w);
	if (wrong.length > 25) console.log(`   ... +${wrong.length - 25} more`);
	return { ok, n: items.length, cost, p50: p(50), p95: p(95), calls };
}

console.log("config A (classifier only)...");
const resA = await pool((it) => classifyA(it.msg), items);
const repA = report(`A classifier-only [${CLASSIFIER_MODEL}]`, items, resA);
console.log("config B (clarify + classify)...");
const resB = await pool((it) => classifyB(it.msg), items);
const repB = report(`B clarify+classify [${CLARIFIER_MODEL} + ${CLASSIFIER_MODEL}]`, items, resB);

console.log(`\n== A vs B: accuracy ${repA.ok}/${repA.n} vs ${repB.ok}/${repB.n} | p50 ${repA.p50} vs ${repB.p50}ms | p95 ${repA.p95} vs ${repB.p95}ms | cost $${repA.cost.toFixed(5)} vs $${repB.cost.toFixed(5)} | calls ${repA.calls} vs ${repB.calls}`);
console.log(repB.ok > repA.ok ? "clarification HELPED accuracy (at extra latency/cost)" : repB.ok < repA.ok ? "clarification HURT accuracy (extra latency/cost for nothing)" : "clarification did not change accuracy (only extra latency/cost)");

// Garbage probe: starve the model so it returns truncated/empty content; the pipeline must fall back.
console.log("\ngarbage probe (max_tokens=8 forces truncation)...");
let fellBack = 0;
for (const m of items.slice(0, 3).map((x) => x.msg)) {
	const r = await chat({ model: CLASSIFIER_MODEL, system: classifierSystem, user: m, maxTokens: 8 });
	const p = r.text ? parseClassify(r.text) : { error: "empty" };
	if (p.error || r.error) fellBack++;
	console.log(`   msg "${m.slice(0, 50)}..." -> ${r.error ?? p.error ?? `${p.agent}/${p.confidence}`} (fallback ${p.error || r.error ? "YES" : "NO"})`);
}
console.log(fellBack === 3 ? "garbage probe: all truncated answers detected -> safe fallback to human" : `garbage probe: ${fellBack}/3 fell back`);

// Cascade probe: short deictic messages where clarification is the whole point.
console.log("\ncascade probe (messy messages: A guesses alone, B may ask)...");
for (const m of ["fix it", "se kaatuu taas, kattokaa", "pr 412?"]) {
	const a = await classifyA(m);
	const b = await classifyB(m);
	console.log(`   "${m}" -> A: ${a.predicted} (${a.why}) | B: ${b.predicted} (${b.why})`);
}
