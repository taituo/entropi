// experimental: front desk router OpenRouter backend (off unless ENTROPI_EXPERIMENTAL_ROUTER=1).
import type { AgentDesc, Classification, Clarifier, Classifier, ClarifyResult } from "./ports.ts";

/**
 * OpenRouter-backed classifier and clarifier. Plain fetch against chat/completions, temperature 0,
 * response_format json_object and max_tokens >= 2000 (reasoning models are off by default: when a token
 * budget fills up they return empty choices, which must never silently drop a message).
 *
 * The key is passed in, never read here: callers load it at runtime (a live-eval script reads the key file;
 * `npm test` never touches the network). Nothing here logs the key.
 */

export const DEFAULT_CLASSIFIER_MODEL = "amazon/nova-micro-v1";
export const DEFAULT_CLARIFIER_MODEL = "inception/mercury-2.5";

export class RouterModelError extends Error {
	readonly kind: "timeout" | "http" | "parse" | "empty";
	constructor(kind: RouterModelError["kind"], detail: string, cause?: unknown) {
		super(`router model ${kind}: ${detail}`, { cause });
		this.kind = kind;
	}
}

/** The exact system prompt, exported so the live-eval script and tests pin the same words. */
export function classifierSystemPrompt(agents: AgentDesc[]): string {
	return `You route chat messages to exactly one agent, or none. Agents:\n${agents.map((a) => `- ${a.handle}: ${a.description}`).join("\n")}\nIf the message is small talk or fits no agent, answer "none". Review-intent wins: if the message asks someone to look at, review, approve, sign off or merge a PR, pull, branch or diff, answer "reviewer" even when code or ops words appear. Reply with ONLY JSON: {"agent":"<handle|none>","confidence":<0..1>}`;
}

export function clarifierSystemPrompt(agents: AgentDesc[]): string {
	return `You clarify messy chat messages for a router. Handles: ${agents.map((a) => a.handle).join(", ")}.\nIf the message is self-contained, reply with ONLY JSON: {"request":"<standalone request with names/ids kept>"}. If essential context is missing, reply with ONLY JSON: {"question":"<one short clarifying question>"}. Small talk needs no clarification: echo it back as {"request":"<the message>"}.`;
}

export type OpenRouterOpts = {
	apiKey: string;
	model?: string;
	timeoutMs?: number;
	maxTokens?: number;
	fetchImpl?: typeof fetch;
};

type ChatResult = { text: string; cost: number | null; ms: number };

async function chatCompletions(o: OpenRouterOpts & { system: string; user: string }): Promise<ChatResult> {
	const started = Date.now();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 60_000);
	try {
		const res = await (o.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			signal: ctrl.signal,
			headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "entropi-router", "X-Title": "entropi-router" },
			body: JSON.stringify({
				model: o.model, temperature: 0, max_tokens: Math.max(o.maxTokens ?? 2500, 2000),
				response_format: { type: "json_object" },
				messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }],
			}),
		});
		if (!res.ok) throw new RouterModelError("http", `status ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
		const text = j.choices?.[0]?.message?.content ?? "";
		if (!text.trim()) throw new RouterModelError("empty", "the model returned no content");
		const cost = typeof j.usage?.cost === "number" ? j.usage.cost : null;
		return { text, cost, ms: Date.now() - started };
	} catch (e) {
		if (e instanceof RouterModelError) throw e;
		if (e instanceof DOMException && e.name === "AbortError") throw new RouterModelError("timeout", `no answer in ${o.timeoutMs ?? 60_000} ms`, e);
		throw new RouterModelError("http", (e as Error).message, e);
	} finally {
		clearTimeout(timer);
	}
}

const firstJsonObject = (text: string): unknown => {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) throw new RouterModelError("parse", `no JSON object in: ${text.slice(0, 200)}`);
	try {
		return JSON.parse(m[0]);
	} catch (e) {
		throw new RouterModelError("parse", `invalid JSON: ${m[0].slice(0, 200)}`, e);
	}
};

export class OpenRouterClassifier implements Classifier {
	readonly model: string;
	private opts: OpenRouterOpts;
	constructor(o: OpenRouterOpts) {
		if (!o.apiKey) throw new Error("OpenRouterClassifier needs an apiKey");
		this.opts = o;
		this.model = o.model ?? DEFAULT_CLASSIFIER_MODEL;
	}
	async classify(message: string, agents: AgentDesc[]): Promise<Classification> {
		const handles = new Set(agents.map((a) => a.handle.toLowerCase()));
		const { text } = await chatCompletions({ ...this.opts, model: this.model, system: classifierSystemPrompt(agents), user: message });
		const out = firstJsonObject(text) as { agent?: unknown; confidence?: unknown };
		const agent = String(out.agent ?? "").toLowerCase().replace(/^@/, "");
		const confidence = Math.min(1, Math.max(0, Number(out.confidence)));
		if ((!handles.has(agent) && agent !== "none") || !Number.isFinite(confidence)) {
			throw new RouterModelError("parse", `unusable classification: ${text.slice(0, 200)}`);
		}
		return { agent, confidence };
	}
}

export class OpenRouterClarifier implements Clarifier {
	readonly model: string;
	private opts: OpenRouterOpts;
	constructor(o: OpenRouterOpts) {
		if (!o.apiKey) throw new Error("OpenRouterClarifier needs an apiKey");
		this.opts = o;
		this.model = o.model ?? DEFAULT_CLARIFIER_MODEL;
	}
	async clarify(message: string, agents: AgentDesc[]): Promise<ClarifyResult> {
		const { text } = await chatCompletions({ ...this.opts, model: this.model, system: clarifierSystemPrompt(agents), user: message });
		const out = firstJsonObject(text) as { request?: unknown; question?: unknown };
		if (typeof out.question === "string" && out.question.trim()) return { kind: "question", question: out.question.trim().slice(0, 500) };
		if (typeof out.request === "string" && out.request.trim()) return { kind: "clear", text: out.request.trim().slice(0, 2000) };
		throw new RouterModelError("parse", `unusable clarification: ${text.slice(0, 200)}`);
	}
}
