import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, watchEvents, type Conversation, type EntryRecord, type Extension, type Storage, type SubmissionId } from "@earendil-works/pi-durable";
import { handleOf } from "../../core/core.ts";
import type { Core } from "../../core/core.ts";
import type { AgentDispatcher } from "../../core/ports.ts";
import { OptChat, SUMMARY_SYSTEM, TreeBuilder } from "../../core/optchat.ts";
import type { DecisionRequest, Id, Message } from "../../core/types.ts";
import { Binding, bindingKey } from "./binding.ts";
import type { Inference, ModelRef } from "./inference.ts";
import { entropiExtension } from "./tools.ts";
import { PiTranscript } from "./transcript.ts";

const ctx = BACKGROUND_CONTEXT;
type Step = { id: string; name: string; args: string; status: "running" | "done" | "error"; preview?: string };
type Loc = { realmId: Id; spaceId: Id; agentId: Id };
const short = (v: unknown, n: number) => {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
const textOf = (content: any): string => (typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""));

export type PiRuntimeOptions = {
	core: Core;
	storage: Storage;
	inference: Inference;
	/** Pushed for every streaming update of an agent message (never logged, never replayed). */
	live?: (m: Message) => void;
	extensions?: Extension[];
	memory?: OptChat;
	viewBytes?: number;
	keepRecentTokens?: number;
	/** "provider/model" used to write OptChat summaries; extractive summaries without it. */
	summarizerModel?: ModelRef;
	settings?: Record<string, unknown>;
};

/**
 * Runs agents on Pi Durable. Pi owns everything stateful about a conversation (transcript, tasks, submissions, which
 * conversation belongs to which space+agent); the core owns spaces, people's messages, work and decisions. The two meet
 * in exactly three idempotent places, so no fact has two writers:
 *   1. dispatch:  core outbox row  --(requestId msg:<id>:<agent>)-->  Pi submission
 *   2. projection: Pi transcript   --(requestId reply:<id>:<agent>)-->  the agent's message in the core (rebuildable)
 *   3. tools:     Pi task id       --(keys ap:/ask:<taskId>)-->        decisions and delegations in the core
 */
export class PiRuntime implements AgentDispatcher {
	readonly core: Core;
	readonly storage: Storage;
	readonly memory: OptChat;
	readonly builder: TreeBuilder;
	harness!: Harness;
	private opts: PiRuntimeOptions;
	private convs = new Map<string, Conversation>(); // binding key -> conversation
	private locs = new Map<string, Loc>(); // conversation id -> binding
	private creating = new Map<string, Promise<Conversation>>();
	private tracking = new Set<number>(); // reply message ids being awaited
	private lives = new Map<string, LiveState>();
	private closed = false;
	private decisionWaiters = new Set<() => void>();
	private off?: () => void;

	constructor(o: PiRuntimeOptions) {
		this.opts = o;
		this.core = o.core;
		this.storage = o.storage;
		this.memory = o.memory ?? new OptChat(o.core.db);
		this.builder = new TreeBuilder(this.memory);
		this.builder.log = (m) => console.warn(`[memtree] ${m}`);
	}

	// ------------------------------------------------------------------ lifecycle

	async start() {
		const registry = createRegistry();
		const host = {
			core: this.core, memory: this.memory, viewBytes: this.opts.viewBytes ?? 6000,
			locate: (id: unknown) => this.locs.get(String(id)),
			depthOf: (id: unknown) => Number(this.workingReplyOf(String(id))?.meta.depth ?? 0),
			waitDecision: (realm: Id, id: Id, signal?: AbortSignal) => this.waitDecision(realm, id, signal),
		};
		registry.install(entropiExtension(host));
		for (const e of this.opts.extensions ?? []) registry.install(e);
		this.harness = await Harness.open(this.storage, {
			models: this.opts.inference.models, registry,
			settings: { toolExecution: "parallel", retry: { maxRetries: 2 }, stream: { timeoutMs: 180_000 }, compaction: { enabled: true, keepRecentTokens: this.opts.keepRecentTokens ?? 20_000 }, ...this.opts.settings } as any,
		}, ctx);
		this.setupSummarizer();
		// Decisions made by people wake any tool that waits for them.
		this.off = this.core.subscribe((e) => { if (e.type.startsWith("decision.")) for (const w of [...this.decisionWaiters]) w(); });
		await this.indexBindings();
		for (const [key, id] of [...this.convs]) await this.attach(key, id);
		await this.recover();
		this.harness.resume();
	}

	async close() {
		this.closed = true;
		this.off?.();
		for (const w of [...this.decisionWaiters]) w();
		for (const l of this.lives.values()) clearTimeout(l.timer);
		await this.harness?.close(ctx);
	}

	/** Read the conversation index back from Pi: the binding documents are the only record of who belongs where. */
	private async indexBindings() {
		let cursor: any;
		do {
			const page = await this.storage.scanConversations({}, 200, cursor, ctx);
			for (const c of page.items) {
				const b = await this.harness.snapshot(Binding, c.id, ctx);
				if (b?.realm) {
					const key = bindingKey(b);
					this.convs.set(key, (await this.harness.conversation(c.id, ctx))!);
					this.locs.set(String(c.id), { realmId: b.realm, spaceId: b.space, agentId: b.agent });
				}
			}
			cursor = page.next;
		} while (cursor);
	}

	/** Re-attach to agent messages a dead process left half-written: their submissions are still in Pi. */
	private async recover() {
		for (const m of this.core.workingMessages()) {
			const pi = m.meta.pi as { thread?: string; requestId?: string } | undefined;
			if (!pi?.thread || !pi.requestId) continue; // not ours (e.g. another adapter)
			const rec = await this.storage.submissionByRequest(Number(pi.thread) as any, pi.requestId, ctx);
			if (rec) this.track(m, rec.id);
			// No submission: the crash was between the reply row and the submit. The outbox row is still pending, so the pump redelivers.
		}
	}

	// ------------------------------------------------------------------ conversations

	locate(conversationId: unknown): Loc | undefined {
		return this.locs.get(String(conversationId));
	}

	private workingReplyOf(thread: string): Message | undefined {
		return this.core.workingMessages().filter((m) => (m.meta.pi as any)?.thread === thread).at(-1);
	}

	private instructionsFor(loc: Loc): string {
		const agent = this.core.getActor(loc.realmId, loc.agentId)!;
		const space = this.core.getSpace(loc.realmId, loc.spaceId)!;
		const base = String(agent.profile.instructions ?? `You are ${agent.name}, an agent working next to people and other agents. Be concise, use tools to gather evidence, and say plainly what is blocked.`);
		const where = space.kind === "dm" ? "This is a private one-to-one chat with one person. Answer every message; never mention or relay it to other channels." : `You are "${agent.name}" in the space #${space.id}.`;
		return `${base}\n\n${where}`;
	}

	private modelFor(loc: Loc): ModelRef {
		const ref = this.opts.inference.resolve(handleOf(loc.agentId));
		if (!ref) throw new Error(`no model configured for ${handleOf(loc.agentId)}: set LOCAL_LLM_BASE_URL+LOCAL_LLM_MODEL, INFERENCE_DEFAULT or AGENT_${handleOf(loc.agentId).toUpperCase()}_MODEL`);
		return ref;
	}

	/** One conversation per (realm, space, agent), created at most once even when two messages arrive together. */
	private async ensureConv(loc: Loc): Promise<Conversation> {
		const key = bindingKey({ realm: loc.realmId, space: loc.spaceId, agent: loc.agentId });
		const have = this.convs.get(key);
		if (have) return have;
		const pending = this.creating.get(key);
		if (pending) return pending;
		const p = (async () => {
			const conv = await this.harness.createConversation({
				ownership: { kind: "ownerless" },
				agent: { model: this.modelFor(loc), instructions: this.instructionsFor(loc) },
				// Same commit as the conversation itself: it can never exist unbound.
				init: async (tx, id) => {
					const d = await tx.doc(Binding, id);
					d.realm = loc.realmId; d.space = loc.spaceId; d.agent = loc.agentId;
				},
			}, ctx);
			this.convs.set(key, conv);
			this.locs.set(String(conv.id), loc);
			await this.attach(key, conv);
			return conv;
		})().finally(() => this.creating.delete(key));
		this.creating.set(key, p);
		return p;
	}

	private async syncAgent(conv: Conversation, loc: Loc) {
		const want = this.modelFor(loc);
		const have = (await conv.agent(ctx).catch(() => undefined))?.model as ModelRef | undefined;
		if (have && (have.provider !== want.provider || have.modelId !== want.modelId)) await conv.configure({ model: want }, ctx);
		await conv.configure({ instructions: this.instructionsFor(loc) }, ctx);
	}

	// ------------------------------------------------------------------ dispatch (core outbox -> Pi submission)

	async dispatch(o: { realmId: Id; spaceId: Id; agentId: Id; text: string; from: Id; messageId: number; depth?: number }): Promise<void> {
		const { core } = this;
		const loc: Loc = { realmId: o.realmId, spaceId: o.spaceId, agentId: o.agentId };
		const conv = await this.ensureConv(loc);
		const requestId = `msg:${o.messageId}:${o.agentId}`;
		// 1. The reply row exists before Pi is told anything, so a half-done hand-over is always visible and recoverable.
		const { message: reply } = core.postMessage(o.realmId, o.spaceId, o.agentId, {
			text: "", status: "working", requestId: `reply:${o.messageId}:${o.agentId}`,
			meta: { pi: { thread: String(conv.id), requestId }, depth: o.depth ?? 0, activity: [] },
		});
		if (reply.status === "done") return; // delivered and answered before; a redelivery has nothing left to do
		await this.syncAgent(conv, loc);
		const sender = core.getActor(o.realmId, o.from)?.name ?? o.from;
		const space = core.getSpace(o.realmId, o.spaceId)!;
		const header = `[${space.kind === "dm" ? "private chat" : `#${space.id}`}] ${core.getActor(o.realmId, o.from)?.kind === "agent" ? `@${handleOf(o.from)} (agent)` : sender}: ${o.text}`;
		// 2. Exactly-once on Pi's side: the same requestId always returns the same submission.
		const sub = await conv.submit({ type: "input", content: header, requestId }, ctx);
		this.track(reply, sub.id);
	}

	/** Wait for a submission to settle, then make the core's message a pure function of the transcript. */
	private track(reply: Message, submissionId: SubmissionId) {
		if (this.tracking.has(reply.id) || this.closed) return;
		this.tracking.add(reply.id);
		void (async () => {
			try {
				const sub = await this.harness.submission(submissionId, ctx);
				if (!sub) throw new Error(`submission ${submissionId} vanished`);
				await sub.wait(ctx);
				await this.finalize(reply.id, submissionId);
			} catch (e) {
				if (!this.closed) console.error("tracking failed", e);
			} finally {
				this.tracking.delete(reply.id);
			}
		})();
	}

	// ------------------------------------------------------------------ projection (Pi transcript -> core message)

	private async finalize(messageId: number, submissionId: SubmissionId) {
		const { core } = this;
		const cur = core.findMessage(messageId);
		if (!cur || cur.status === "done") return;
		const rec = await this.storage.submission(submissionId, ctx);
		if (!rec) return;
		const live = this.lives.get((cur.meta.pi as any).thread);
		if (live) { clearTimeout(live.timer); live.timer = undefined; }
		const pi = cur.meta.pi as { thread: string };
		let body = "";
		let activity: Step[] = [];
		if (rec.status === "done") {
			const entries = await this.entriesBetween(pi.thread, Number(rec.entry), Number(rec.answer));
			({ text: body, activity } = project(entries));
		} else if (rec.status === "unanswered") {
			const entries = rec.entry ? await this.entriesBetween(pi.thread, Number(rec.entry), Number.MAX_SAFE_INTEGER) : [];
			const p = project(entries);
			body = `${p.text}${p.text ? "\n\n" : ""}⚠ No answer: ${rec.reason}`;
			activity = p.activity;
		} else return;
		const done = core.updateMessage(cur.realmId, messageId, cur.authorId, { text: body || "(no answer)", meta: { ...cur.meta, activity }, status: "done" });
		this.opts.live?.(done);
		await this.memory.sync(pi.thread, new PiTranscript(this.storage, ctx), () => this.builder.onLeaf(pi.thread)).catch((e) => console.warn("memory sync failed", e));
		this.builder.backfill(pi.thread);
	}

	private async entriesBetween(thread: string, from: number, to: number): Promise<EntryRecord[]> {
		const out: EntryRecord[] = [];
		let cursor: any;
		do {
			const page = await this.storage.scanEntries({ conversationId: Number(thread) as any, minEntryId: from as any, maxEntryId: (to > 1e15 ? undefined : to) as any }, 200, cursor, ctx);
			out.push(...page.items);
			cursor = page.next;
		} while (cursor);
		return out.sort((a, b) => Number(a.id) - Number(b.id));
	}

	// ------------------------------------------------------------------ live streaming (ephemeral overlay)

	private async attach(key: string, conv: Conversation | any) {
		const id = String(conv.id ?? conv);
		const stream = await watchEvents(this.harness, conv.id ?? conv, ctx);
		const live: LiveState = { current: undefined, text: new Map(), final: "", activity: [], timer: undefined };
		this.lives.set(id, live);
		await this.onEvent(id, live, stream.snapshot);
		stream.start(async (events) => { for (const ev of events) await this.onEvent(id, live, ev).catch((e) => console.error("event error", e)); });
	}

	private async resolveCurrent(inputs: readonly unknown[]): Promise<Message | undefined> {
		for (const sid of inputs) {
			const rec = await this.storage.submission(sid as any, ctx);
			const m = /^msg:(\d+):(.+)$/.exec(rec?.requestId ?? "");
			if (!m) continue;
			const row = this.core.db.prepare("SELECT id, realm_id FROM messages WHERE request_id = ?").get(`reply:${m[1]}:${m[2]}`) as { id: number; realm_id: string } | undefined;
			const msg = row && this.core.getMessage(row.realm_id, row.id);
			if (msg && msg.status === "working") return msg;
		}
		return undefined;
	}

	private flush(live: LiveState, now = false) {
		if (!live.current) return;
		if (!now) { live.timer ??= setTimeout(() => this.flush(live, true), 120); return; }
		clearTimeout(live.timer); live.timer = undefined;
		const cur = this.core.getMessage(live.current.realmId, live.current.id);
		if (!cur || cur.status !== "working") return; // finalised meanwhile: the transcript projection wins
		const partial = [...live.text.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join("");
		const display = [live.final, partial].filter(Boolean).join(live.final && partial ? "\n\n" : "");
		const m = this.core.updateMessage(cur.realmId, cur.id, cur.authorId, { text: display, meta: { ...cur.meta, activity: live.activity } });
		this.opts.live?.(m);
	}

	private async onEvent(id: string, live: LiveState, ev: any) {
		switch (ev.type) {
			case "snapshot":
				live.text.clear(); live.final = ""; live.activity = [];
				if (ev.run) {
					live.current = await this.resolveCurrent(ev.run.inputs);
					const m = ev.generation?.message;
					if (m) live.text.set(0, textOf(m.content));
					this.flush(live);
				} else live.current = undefined;
				break;
			case "run_start":
				live.text.clear(); live.final = ""; live.activity = [];
				live.current = await this.resolveCurrent(ev.inputs);
				break;
			case "message_start":
				live.text.clear();
				break;
			case "message_update":
				for (const c of ev.changes) {
					if (c.type === "text_start") live.text.set(c.contentIndex, c.block.text ?? "");
					else if (c.type === "text_delta") live.text.set(c.contentIndex, (live.text.get(c.contentIndex) ?? "") + c.delta);
					else if (c.type === "block" && c.block.type === "text") live.text.set(c.contentIndex, c.block.text);
					else if (c.type === "message") { live.text.clear(); live.text.set(0, textOf(c.message.content)); }
				}
				this.flush(live);
				break;
			case "message_end": {
				const msg = ev.entry?.model?.[0];
				live.text.clear();
				if (msg?.role === "assistant") {
					const t = textOf(msg.content).trim();
					if (t) live.final = live.final ? `${live.final}\n\n${t}` : t;
				}
				this.flush(live);
				break;
			}
			case "tool_execution_start":
				live.activity.push({ id: ev.toolCallId, name: ev.toolName, args: short(ev.args, 220), status: "running" });
				this.flush(live);
				break;
			case "tool_execution_end": {
				const a = live.activity.find((x) => x.id === ev.toolCallId);
				const res = ev.entry?.model?.[0];
				if (a) { a.status = !ev.entry || res?.isError ? "error" : "done"; a.preview = short(textOf(res?.content), 500); }
				this.flush(live);
				break;
			}
			case "run_end":
				this.flush(live, true);
				break;
		}
	}

	// ------------------------------------------------------------------ decisions

	/** Wait for a person to decide. The core is the only truth; this just wakes up when it changes (or every few seconds). */
	waitDecision(realmId: Id, decisionId: Id, signal?: AbortSignal): Promise<DecisionRequest> {
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const check = () => {
				const d = this.core.getDecision(realmId, decisionId);
				if (!d) return done(() => reject(new Error("decision vanished")));
				if (d.status !== "open") return done(() => resolve(d));
				if (this.closed) return done(() => reject(new Error("runtime closed while waiting for approval")));
				clearTimeout(timer);
				timer = setTimeout(check, 5000);
			};
			const onAbort = () => done(() => reject(new Error("aborted while waiting for approval")));
			const done = (fn: () => void) => { clearTimeout(timer); this.decisionWaiters.delete(check); signal?.removeEventListener("abort", onAbort); fn(); };
			this.decisionWaiters.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	async stop(realmId: Id, spaceId: Id, agentId: Id) {
		const conv = this.convs.get(bindingKey({ realm: realmId, space: spaceId, agent: agentId }));
		if (conv) await conv.abort(ctx);
	}

	/** Compress an agent's context with the OptChat view of its whole history (manual trigger for the UI). */
	async compact(realmId: Id, spaceId: Id, agentId: Id): Promise<{ compacted: boolean }> {
		const conv = this.convs.get(bindingKey({ realm: realmId, space: spaceId, agent: agentId }));
		if (!conv) return { compacted: false };
		const id = await conv.compact("Replace the earlier history with the compressed memory view.", ctx);
		const done = (await this.harness.waitForTask(id, ctx)).state as any;
		return { compacted: done.outcome?.status === "completed" && done.outcome?.result?.submissionId !== undefined };
	}

	private setupSummarizer() {
		const ref = this.opts.summarizerModel ?? this.opts.inference.resolve("");
		if (!ref) return; // extractive summaries only
		const models: Models = this.opts.inference.models;
		this.builder.summarize = async (texts) => {
			const model = models.getModel(ref.provider, ref.modelId);
			if (!model) throw new Error("summarizer model not available");
			const msg = await models.complete(model, { systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: `Chunk A:\n${texts[0]}\n\nChunk B:\n${texts[1]}`, timestamp: Date.now() }] });
			if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? "summarizer error");
			return textOf(msg.content).trim();
		};
	}
}

type LiveState = { current: Message | undefined; text: Map<number, string>; final: string; activity: Step[]; timer: NodeJS.Timeout | undefined };

/** The text and tool activity of a run, as a pure function of its transcript entries. */
export function project(entries: readonly EntryRecord[]): { text: string; activity: Step[] } {
	const texts: string[] = [];
	const steps = new Map<string, Step>();
	for (const e of entries) {
		const msg: any = e.model?.[0];
		if (!msg) continue;
		if (e.kind === "pi.assistant") {
			const t = textOf(msg.content).trim();
			if (t) texts.push(t);
			for (const b of msg.content ?? []) if (b.type === "toolCall") steps.set(b.id, { id: b.id, name: b.name, args: short(b.arguments, 220), status: "running" });
		} else if (e.kind === "pi.tool-result") {
			const s = steps.get(msg.toolCallId);
			if (s) { s.status = msg.isError ? "error" : "done"; s.preview = short(textOf(msg.content), 500); }
		}
	}
	return { text: texts.join("\n\n"), activity: [...steps.values()] };
}
