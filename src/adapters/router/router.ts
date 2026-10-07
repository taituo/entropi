import { handleOf, type Core } from "../../core/core.ts";
import type { AgentDesc, Classifier, Clarifier } from "./ports.ts";
import type { FeedbackStore } from "./feedback.ts";

/**
 * The front desk: a special channel where people write WITHOUT @-mentions. Cascade, and only a cascade:
 * classify first; clarify only when confidence is low or the message has no standalone context; then route,
 * ask a human, or politely decline. Nothing here is ever lost silently: every path posts something visible
 * (a routing line, a question, a decision card, or a polite reply), and a model failure falls back to a
 * human choice.
 *
 * Core stays free of opinions: this speaks only through actor-checked operations (postMessage, createWork,
 * requestDecision). No core changes, no new event types, no raw SQL.
 */

export const ROUTER_AGENTS: AgentDesc[] = [
	{ handle: "ops", description: "Investigates live systems: pods, logs, crash loops, restarts, metrics. Applies approved config changes." },
	{ handle: "developer", description: "Writes and fixes code in a sandbox, runs tests, prepares branches and patches." },
	{ handle: "reviewer", description: "Reviews changes and branches, approves or rejects with reasons. Does not write code." },
	{ handle: "insight", description: "Analyses data and metrics, makes charts, explains anomalies and trends." },
];

export const DEFAULT_THRESHOLD = 0.7;
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 30_000;

export type RouteOutcome =
	| { kind: "passed"; reason: string }
	| { kind: "routed"; agent: string; confidence: number; clarified: boolean; noticeId: number; dispatchId: number }
	| { kind: "needs-human"; decisionId: string; candidates: string[]; confidence: number }
	| { kind: "none"; replyId: number }
	| { kind: "clarify"; question: string; replyId: number };

export type FrontDeskOptions = {
	core: Core;
	realmId: string;
	spaceId: string;
	classifier: Classifier;
	clarifier?: Clarifier;
	agents?: AgentDesc[];
	threshold?: number;
	classifyTimeoutMs?: number;
	feedback?: FeedbackStore;
};

/** The visible routing line in the channel. */
export const formatNotice = (agent: string, confidence: number): string => `-> @${agent} (${confidence.toFixed(2)})`;

/** Small talk is answerable as-is ("none"); it never needs clarification. Shared with the Fake. */
const SMALLTALK_RE = /kiitti|kiitos|thanks|\bthx\b|louna|\blunch\b|kahvi|pannu|\bcoffee\b|\bafk\b|\bretro\b|sprint planning|kalenteri|kokous|meeting|google meet|\bjoin\b|\bbot\b|huomenta|maanantai|sade|raining|cycling|\blol\b|haha|laptop|\bm3\b|mitä kuuluu|theme|taste|\bhr\b|pekkaspäiv|saikulla|huomiselle|siirret/i;
export function isSmallTalk(text: string): boolean {
	return SMALLTALK_RE.test(text);
}

/**
 * Does the message lack standalone context (a "cascade" case)? Short deictic messages ("fix it", "katso toi")
 * cannot be classified alone; self-contained ones (names, ids, substance) can. Deterministic and tested.
 */
export function lacksContext(text: string): boolean {
	const t = text.trim();
	if (t.length === 0) return true;
	if (isSmallTalk(t)) return false;
	if (/^(se|tämä|tää|toi|tuo|ne|it|this|that|these|those|fix it|do it|katso|tsekkaa)\W*$/i.test(t)) return true;
	if (t.length < 30) {
		const substance = /(api|pod|service|pr\b|branch|chart|kuvaaja|käppyr|koodi|config|db|maksu|payment|checkout|ticket|[A-Z]+-\d+|#\d+|error|test|data|loki|logi|muisti|kuorma)/i.test(t);
		if (!substance) return true;
		const deictic = /(^|\W)(se|tämä|tää|toi|tuo|ne|it|this|that)\b/i.test(t);
		if (deictic) return true;
	}
	return false;
}

const CORRECTION_RE = /^\s*(ei kun|eipä|ei|no+|nope|wrong|väärin)\b[,.!]?\s*@?([a-zA-Z][\w-]*)/i;

/** "ei, developer" / "no, ops" -> the corrected handle, or null. Corrections are stored as teaching data. */
export function parseCorrection(text: string, agents: AgentDesc[]): string | null {
	const m = CORRECTION_RE.exec(text);
	if (!m) return null;
	const want = m[2].toLowerCase();
	return agents.some((a) => a.handle.toLowerCase() === want) ? agents.find((a) => a.handle.toLowerCase() === want)!.handle : null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export class FrontDesk {
	private core: Core;
	private realmId: string;
	private spaceId: string;
	private classifier: Classifier;
	private clarifier?: Clarifier;
	private agents: AgentDesc[];
	private threshold: number;
	private timeoutMs: number;
	private feedback?: FeedbackStore;
	private lastRoute = new Map<number, string>();

	constructor(o: FrontDeskOptions) {
		this.core = o.core;
		this.realmId = o.realmId;
		this.spaceId = o.spaceId;
		this.classifier = o.classifier;
		this.clarifier = o.clarifier;
		this.agents = o.agents ?? ROUTER_AGENTS;
		this.threshold = o.threshold ?? DEFAULT_THRESHOLD;
		this.timeoutMs = o.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
		this.feedback = o.feedback;
	}

	private agentId(handle: string): string | undefined {
		const space = this.core.getSpace(this.realmId, this.spaceId);
		return space?.agentIds.find((id) => handleOf(id) === handle.toLowerCase());
	}

	/** Route one human message. Never throws away the message: failures become a human choice. */
	async handle(o: { text: string; by: string; messageId?: number }): Promise<RouteOutcome> {
		const { core, realmId, spaceId } = this;
		const space = core.getSpace(realmId, spaceId);
		if (!space) throw new Error(`no such space ${spaceId}`);
		const { present } = core.mentions(realmId, spaceId, o.text);
		if (present.length > 0) return { kind: "passed", reason: `@-mentioned (${present.map(handleOf).join(", ")}): the normal path handles it` };

		let first: { agent: string; confidence: number };
		try {
			first = await withTimeout(this.classifier.classify(o.text, this.agents), this.timeoutMs, "classify");
		} catch {
			return this.askHuman(o, { agent: "none", confidence: 0 }, "the classifier failed");
		}

		let final = first;
		let request = o.text;
		let clarified = false;
		if (this.clarifier && (first.confidence < this.threshold || lacksContext(o.text))) {
			try {
				const cl = await withTimeout(this.clarifier.clarify(o.text, this.agents), this.timeoutMs, "clarify");
				if (cl.kind === "question") {
					const { message } = core.postMessage(realmId, spaceId, "system", {
						text: cl.question, requestId: o.messageId !== undefined ? `route-q:${o.messageId}` : undefined,
					});
					return { kind: "clarify", question: cl.question, replyId: message.id };
				}
				request = cl.text;
				clarified = cl.text !== o.text.trim();
				final = await withTimeout(this.classifier.classify(cl.text, this.agents), this.timeoutMs, "classify");
			} catch {
				final = first; // clarification is best-effort: fall through with the first answer
			}
		}
		return this.finish({ ...o, text: request }, final, { clarified });
	}

	private finish(o: { text: string; messageId?: number }, c: { agent: string; confidence: number }, extra: { clarified: boolean }): RouteOutcome {
		const known = this.agents.some((a) => a.handle.toLowerCase() === c.agent.toLowerCase()) || c.agent === "none";
		if (!known) return this.askHuman(o, c, `the classifier returned an unknown agent "${c.agent}"`);
		if (c.agent === "none" && c.confidence >= this.threshold) {
			const { message } = this.core.postMessage(this.realmId, this.spaceId, "system", {
				text: `No agent here fits this message (${this.agents.map((a) => `@${a.handle}`).join(", ")}), so I'll leave it for the humans. Mention one with @ if you meant it for an agent.`,
				requestId: o.messageId !== undefined ? `route-none:${o.messageId}` : undefined,
			});
			return { kind: "none", replyId: message.id };
		}
		if (c.confidence >= this.threshold && c.agent !== "none") {
			const id = this.agentId(c.agent);
			if (!id) return this.askHuman(o, c, `@${c.agent} is not in this space`);
			const { core, realmId, spaceId } = this;
			const notice = core.postMessage(realmId, spaceId, "system", {
				text: formatNotice(c.agent, c.confidence), kind: "notice",
				requestId: o.messageId !== undefined ? `route-notice:${o.messageId}` : undefined,
			});
			const dispatch = core.postMessage(realmId, spaceId, "system", {
				text: o.text, dispatchTo: [id],
				meta: { routedFrom: o.messageId ?? null, confidence: c.confidence, clarified: extra.clarified ?? false },
				requestId: o.messageId !== undefined ? `route-dispatch:${o.messageId}` : undefined,
			});
			if (o.messageId !== undefined) this.lastRoute.set(o.messageId, c.agent);
			return { kind: "routed", agent: c.agent, confidence: c.confidence, clarified: extra.clarified ?? false, noticeId: notice.message.id, dispatchId: dispatch.message.id };
		}
		return this.askHuman(o, c, "low confidence");
	}

	/** Low confidence, an unusable model answer, or two suitable agents: a human picks (decision + attention). */
	private askHuman(o: { text: string; messageId?: number }, c: { agent: string; confidence: number }, _why: string): RouteOutcome {
		const { core, realmId, spaceId } = this;
		const candidates = [...this.agents.map((a) => a.handle), "none"];
		const key = o.messageId !== undefined ? `route:${o.messageId}` : `route:anon:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
		const work = core.createWork(realmId, {
			id: o.messageId !== undefined ? `route-${o.messageId}` : undefined,
			kind: "routing", title: `Route: ${o.text.slice(0, 80)}`, goal: o.text.slice(0, 500),
			ownerId: null, spaceId, state: "queued",
		}, "system");
		const { decision } = core.requestDecision(realmId, {
			key, workId: work.id,
			question: `Who should handle this? "${o.text.slice(0, 200)}"${c.agent !== "none" ? ` (suggestion: @${c.agent}, ${c.confidence.toFixed(2)})` : ""}`,
			options: candidates, context: { message: o.text, suggestion: c.agent, confidence: c.confidence },
			urgency: "normal", requiredAuthority: "operator",
		}, "system");
		return { kind: "needs-human", decisionId: decision.id, candidates, confidence: c.confidence };
	}

	/**
	 * A human corrects the routing ("ei, developer"): stored as teaching data and re-routed to the
	 * corrected agent. Returns null when the message is not a correction.
	 */
	async correct(o: { text: string; by: string; messageId?: number }): Promise<RouteOutcome | null> {
		const to = parseCorrection(o.text, this.agents);
		if (!to) return null;
		const from = (o.messageId !== undefined ? this.lastRoute.get(o.messageId) : undefined) ?? "unknown";
		await this.feedback?.record({
			at: Date.now(), by: o.by, spaceId: this.spaceId,
			text: o.text, routedTo: from, correctedTo: to,
		});
		const id = this.agentId(to);
		if (!id) return null;
		const { core, realmId, spaceId } = this;
		const notice = core.postMessage(realmId, spaceId, "system", {
			text: `${formatNotice(to, 1)} (korjaus / correction)`, kind: "notice",
			requestId: o.messageId !== undefined ? `route-fix-notice:${o.messageId}` : undefined,
		});
		const dispatch = core.postMessage(realmId, spaceId, "system", {
			text: o.text, dispatchTo: [id],
			meta: { routedFrom: o.messageId ?? null, confidence: 1, correction: true, correctedFrom: from },
			requestId: o.messageId !== undefined ? `route-fix-dispatch:${o.messageId}` : undefined,
		});
		if (o.messageId !== undefined) this.lastRoute.set(o.messageId, to);
		return { kind: "routed", agent: to, confidence: 1, clarified: false, noticeId: notice.message.id, dispatchId: dispatch.message.id };
	}
}
