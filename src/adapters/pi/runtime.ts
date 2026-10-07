import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation, type ConversationView, type EntryRecord, type Extension, type Storage, type SubmissionId } from "@earendil-works/pi-durable";
import { handleOf } from "../../core/core.ts";
import type { Core } from "../../core/core.ts";
import type { AgentControl, AgentDispatcher } from "../../core/ports.ts";
import { OptChat, SUMMARY_SYSTEM, TreeBuilder } from "../../core/optchat.ts";
import type { DecisionRequest, Id, Message } from "../../core/types.ts";
import { Binding, bindingKey } from "./binding.ts";
import type { Inference, ModelRef } from "./inference.ts";
import { entropiExtension } from "./tools.ts";
import { failpoint } from "../../runtime/failpoint.ts";
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
	/** Reads uploaded image bytes by id. Without it images cannot be forwarded (the people are told). */
	images?: { read(id: string, mime: string): Promise<Buffer> };
};

/**
 * Runs agents on Pi Durable. Pi owns everything stateful about a conversation (transcript, tasks, submissions, which
 * conversation belongs to which space+agent); the core owns spaces, people's messages, work and decisions. The two meet
 * in exactly three idempotent places, so no fact has two writers:
 *   1. dispatch:  core outbox row  --(requestId msg:<id>:<agent>)-->  Pi submission
 *   2. projection: Pi transcript   --(requestId reply:<id>:<agent>)-->  the agent's message in the core (rebuildable)
 *   3. tools:     Pi task id       --(keys ap:/ask:<taskId>)-->        decisions and delegations in the core
 */
export class PiRuntime implements AgentDispatcher, AgentControl {
	readonly core: Core;
	readonly storage: Storage;
	readonly memory: OptChat;
	readonly builder: TreeBuilder;
	harness!: Harness;
	private opts: PiRuntimeOptions;
	private extByName = new Map<string, Extension>();
	private convs = new Map<string, Conversation>(); // binding key -> conversation
	private locs = new Map<string, Loc>(); // conversation id -> binding
	private creating = new Map<string, Promise<Conversation>>();
	private tracking = new Set<number>(); // reply message ids being awaited
	private lives = new Map<string, LiveState>();
	private views: { dispose(): void }[] = [];
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
			currentRun: (id: unknown) => this.currentRun(String(id)),
			consultModel: (id: unknown) => { const loc = this.locs.get(String(id)); return this.opts.inference.summarizer() ?? (loc ? this.modelFor(loc) : undefined); },
			waitDecision: (realm: Id, id: Id, signal?: AbortSignal) => this.waitDecision(realm, id, signal),
		};
		const own = entropiExtension(host);
		registry.install(own);
		this.extByName.set(own.name, own);
		for (const e of this.opts.extensions ?? []) { registry.install(e); this.extByName.set(e.name, e); }
		this.harness = await Harness.open(this.storage, {
			models: this.opts.inference.models, registry,
			settings: { toolExecution: "parallel", retry: { maxRetries: 2 }, stream: { timeoutMs: 180_000 }, compaction: { enabled: true, keepRecentTokens: this.opts.keepRecentTokens ?? 20_000 }, ...this.opts.settings } as any,
		}, ctx);
		this.setupSummarizer();
		// Decisions made by people wake any tool that waits for them.
		this.off = this.core.subscribe((e) => { if (e.type.startsWith("decision.")) for (const w of [...this.decisionWaiters]) w(); });
		await this.indexBindings();
		for (const conv of this.convs.values()) await this.attach(conv);
		await this.recover();
		this.harness.resume();
	}

	async close() {
		this.closed = true;
		this.off?.();
		for (const w of [...this.decisionWaiters]) w();
		for (const l of this.lives.values()) clearTimeout(l.timer);
		for (const v of this.views) v.dispose();
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

	/**
	 * The agent message whose run is going on in this conversation. Pi knows which submissions are placed (being worked
	 * on); their request ids name our reply rows. With queued follow-ups there are several working replies, but only the
	 * placed submission is the run in progress.
	 */
	private async currentRun(thread: string): Promise<{ runId: string; depth: number; message: Message } | undefined> {
		const page = await this.storage.scanSubmissions({ conversationId: Number(thread) as any, status: "placed" }, 10, undefined, ctx);
		for (const rec of page.items) {
			const m = /^msg:(\d+):(.+)$/.exec(rec.requestId ?? "");
			if (!m) continue;
			const row = this.core.db.prepare("SELECT id, realm_id FROM messages WHERE request_id = ?").get(`reply:${m[1]}:${m[2]}`) as { id: number; realm_id: string } | undefined;
			const msg = row && this.core.getMessage(row.realm_id, row.id);
			if (msg) return { runId: `run:${msg.id}`, depth: Number(msg.meta.depth ?? 0), message: msg };
		}
		return undefined;
	}

	private instructionsFor(loc: Loc): string {
		const agent = this.core.getActor(loc.realmId, loc.agentId)!;
		const space = this.core.getSpace(loc.realmId, loc.spaceId)!;
		const base = String(agent.profile.instructions ?? `You are ${agent.name}, an agent working next to people and other agents. Be concise, use tools to gather evidence, and say plainly what is blocked.`);
		const where = space.kind === "dm" ? "This is a private one-to-one chat with one person. Answer every message; never mention or relay it to other channels." : `You are "${agent.name}" in the space #${space.id}.`;
		return `${base}\n\n${where}`;
	}

	/** The extensions (tool sets) an agent is given, by name from its profile. No list means everything installed. */
	private extensionsFor(loc: Loc): Extension[] | undefined {
		const names = this.core.getActor(loc.realmId, loc.agentId)?.profile.extensions as string[] | undefined;
		return names ? names.map((n) => this.extByName.get(n)).filter((e): e is Extension => !!e) : undefined;
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
				agent: { model: this.modelFor(loc), instructions: this.instructionsFor(loc), ...(this.extensionsFor(loc) ? { extensions: this.extensionsFor(loc) } : {}) },
				// Same commit as the conversation itself: it can never exist unbound.
				init: async (tx, id) => {
					const d = await tx.doc(Binding, id);
					d.realm = loc.realmId; d.space = loc.spaceId; d.agent = loc.agentId;
				},
			}, ctx);
			this.convs.set(key, conv);
			this.locs.set(String(conv.id), loc);
			await this.attach(conv);
			return conv;
		})().finally(() => this.creating.delete(key));
		this.creating.set(key, p);
		return p;
	}

	private async syncAgent(conv: Conversation, loc: Loc) {
		const want = this.modelFor(loc);
		const have = (await conv.agent(ctx).catch(() => undefined))?.model as ModelRef | undefined;
		if (have && (have.provider !== want.provider || have.modelId !== want.modelId)) await conv.configure({ model: want }, ctx);
		await conv.configure({ instructions: this.instructionsFor(loc), ...(this.extensionsFor(loc) ? { extensions: this.extensionsFor(loc) } : {}) }, ctx);
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
			meta: { pi: { thread: String(conv.id), requestId }, depth: o.depth ?? 0, activity: [], parentRun: (core.getMessage(o.realmId, o.messageId)?.meta.runId as string | undefined) ?? null },
		});
		failpoint("dispatch:after-reply");
		if (reply.status === "done") return; // delivered and answered before; a redelivery has nothing left to do
		await this.syncAgent(conv, loc);
		const sender = core.getActor(o.realmId, o.from)?.name ?? o.from;
		const space = core.getSpace(o.realmId, o.spaceId)!;
		const header = `[${space.kind === "dm" ? "private chat" : `#${space.id}`}] ${core.getActor(o.realmId, o.from)?.kind === "agent" ? `@${handleOf(o.from)} (agent)` : sender}: ${o.text}`;
		const content = await this.contentFor(o, header, loc);
		// 2. Exactly-once on Pi's side: the same requestId always returns the same submission.
		// "steer" (a person chose it) joins the run in progress after its current tool round; the default queues behind it.
		const steer = core.getMessage(o.realmId, o.messageId)?.meta.steer === true;
		const sub = await conv.submit({ type: "input", content, requestId, ...(steer ? { whenBusy: "steer" as const } : {}) }, ctx);
		failpoint("dispatch:after-submit");
		this.track(reply, sub.id);
	}

	/**
	 * What the model receives. Images are never dropped silently: a vision model gets the pixels (as data: URIs, which is
	 * all a gateway accepts), a text-only model gets a plain statement that it cannot see them, and the people get a notice.
	 */
	private async contentFor(o: { realmId: Id; spaceId: Id; agentId: Id; messageId: number }, header: string, loc: Loc): Promise<any> {
		const imgs = (this.core.getMessage(o.realmId, o.messageId)?.meta.images as { id?: string; name?: string; mime?: string }[] | undefined) ?? [];
		if (!imgs.length) return header;
		const ref = this.modelFor(loc);
		const canSee = !!this.opts.inference.models.getModel(ref.provider, ref.modelId)?.input?.includes("image");
		const names = imgs.map((i) => i.name ?? "image").join(", ");
		const refuse = (why: string) => {
			this.core.postMessage(o.realmId, o.spaceId, "system", {
				kind: "notice", requestId: `noimg:${o.messageId}:${o.agentId}`,
				text: `${imgs.length} image attachment(s) (${names}) were NOT sent to ${handleOf(o.agentId)}: ${why}. Describe the key details in text instead.`,
			});
			return `${header}\n\n[${imgs.length} image attachment(s) (${names}) were shared, but you cannot see them (${why}). Say so briefly and ask for the key details as text instead of guessing.]`;
		};
		if (!canSee) return refuse(`the model ${ref.provider}/${ref.modelId} does not support images`);
		if (!this.opts.images) return refuse("this server has no image store configured");
		const blocks: any[] = [{ type: "text", text: header }];
		for (const i of imgs) {
			if (!i.id || !i.mime) continue;
			blocks.push({ type: "image", data: (await this.opts.images.read(i.id, i.mime)).toString("base64"), mimeType: i.mime });
		}
		return blocks;
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
		failpoint("finalize:before-update");
		const live = this.lives.get((cur.meta.pi as any).thread);
		if (live) { clearTimeout(live.timer); live.timer = undefined; }
		const pi = cur.meta.pi as { thread: string };
		let body = "";
		let activity: Step[] = [];
		let failures: { entry: number; stopReason: string; error: string }[] = [];
		if (rec.status === "done") {
			const entries = await this.entriesBetween(pi.thread, Number(rec.entry), Number(rec.answer));
			const p = project(entries);
			({ text: body, activity } = p);
			failures = p.failures;
		} else if (rec.status === "unanswered") {
			const entries = rec.entry ? await this.entriesBetween(pi.thread, Number(rec.entry), Number.MAX_SAFE_INTEGER) : [];
			const p = project(entries);
			const failure = failureText(rec.reason, entries);
			body = `${p.text}${p.text ? "\n\n" : ""}${failure}`;
			activity = p.activity;
			failures = p.failures;
		} else return;
		// Inputs that were steered into a run in progress are answered by that run's single answer: say so once instead of repeating it.
		const answerEntry = rec.status === "done" ? Number(rec.answer) : undefined;
		const twin = answerEntry === undefined ? undefined : core.db.prepare("SELECT id FROM messages WHERE kind = 'agent' AND status = 'done' AND id != ? AND json_extract(meta, '$.pi.thread') = ? AND json_extract(meta, '$.pi.answerEntry') = ?").get(messageId, pi.thread, answerEntry);
		if (twin) { body = "↪ Answered together with the message above."; activity = []; }
		const done = core.updateMessage(cur.realmId, messageId, cur.authorId, { text: body || "(no answer)", meta: { ...cur.meta, pi: { ...(cur.meta.pi as object), ...(answerEntry !== undefined ? { answerEntry } : {}) }, activity, ...(failures.length ? { failures } : {}) }, status: "done" });
		for (const f of failures) console.warn(`[pi] failed generation attempt in ${pi.thread} (entry ${f.entry}, ${f.stopReason}): ${f.error || "no error message"}`);
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

	/**
	 * The one place that listens to a conversation. It uses `viewState()` (the stable structural view: the active transcript
	 * plus the `pi.live` document with the run, the in-flight message and the tool slots), not the Experimental `watchEvents`.
	 * The streamed text and tool activity are `project()` of that very transcript, the same function that writes the final
	 * message, so live and final can never disagree.
	 */
	private async attach(conv: Conversation) {
		const thread = String(conv.id);
		const st: LiveState = { timer: undefined };
		this.lives.set(thread, st);
		const view = await conv.viewState(ctx);
		this.views.push(view);
		const onView = (v: ConversationView) => void this.onView(st, v).catch((e) => console.error("view error", e));
		onView(view.value);
		view.subscribe(onView);
	}

	private async onView(st: LiveState, v: ConversationView) {
		const run = (v.docs["pi.live"] as any)?.run as { inputs: unknown[] } | undefined;
		if (!run) { st.current = undefined; st.runKey = undefined; return; } // the run ended: finalize() writes the final message
		const key = run.inputs.join(",");
		if (st.runKey !== key) { st.runKey = key; Object.assign(st, await this.resolveCurrent(run.inputs)); }
		st.view = v;
		this.flush(st);
	}

	/** The reply row of the run in progress, and the transcript entry where that run starts. */
	private async resolveCurrent(inputs: readonly unknown[]): Promise<{ current?: Message; entryId?: number }> {
		for (const sid of inputs) {
			const rec = await this.storage.submission(sid as any, ctx);
			const m = /^msg:(\d+):(.+)$/.exec(rec?.requestId ?? "");
			if (!m || !rec?.entry) continue;
			const row = this.core.db.prepare("SELECT id, realm_id FROM messages WHERE request_id = ?").get(`reply:${m[1]}:${m[2]}`) as { id: number; realm_id: string } | undefined;
			const msg = row && this.core.getMessage(row.realm_id, row.id);
			if (msg && msg.status === "working") return { current: msg, entryId: Number(rec.entry) };
		}
		return { current: undefined, entryId: undefined };
	}

	private flush(st: LiveState, now = false) {
		if (!st.current) return;
		if (!now) { st.timer ??= setTimeout(() => this.flush(st, true), 120); return; }
		clearTimeout(st.timer); st.timer = undefined;
		const cur = this.core.getMessage(st.current.realmId, st.current.id);
		if (!cur || cur.status !== "working" || !st.view) return; // finalised meanwhile: the transcript projection wins
		const p = project(st.view.entries.filter((e) => Number(e.id) >= (st.entryId ?? 0)));
		const partial = textOf(((st.view.docs["pi.live"] as any)?.generation?.message)?.content).trim();
		if (partial.length > 3) failpoint("stream:mid");
		const display = [p.text, partial].filter(Boolean).join("\n\n");
		const m = this.core.updateMessage(cur.realmId, cur.id, cur.authorId, { text: display, meta: { ...cur.meta, activity: p.activity } });
		this.opts.live?.(m);
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

	// ------------------------------------------------------------------ control (stop, compact, memory, usage)

	/**
	 * Stop an agent in a space and whatever it handed on. Pi's abort cascades to work a task OWNS (its tools, its subagent
	 * helpers), but a visible hand-over to a colleague (ask_agent) is another agent's own conversation, so the chain is
	 * followed through the delegation links the core records: every reply started from this run is stopped too, and
	 * hand-overs still waiting in the outbox are withdrawn.
	 */
	async stop(o: { realmId: Id; spaceId: Id; agentId: Id; by: Id }): Promise<{ stopped: number }> {
		const seen = new Set<number>();
		const stopReply = async (reply: Message): Promise<number> => {
			if (seen.has(reply.id)) return 0;
			seen.add(reply.id);
			const pi = reply.meta.pi as { thread?: string; requestId?: string } | undefined;
			let n = 0;
			if (pi?.thread && pi.requestId) {
				const rec = await this.storage.submissionByRequest(Number(pi.thread) as any, pi.requestId, ctx);
				if (rec) {
					const r = await this.harness.abortSubmission(rec.id, ctx, Number(pi.thread) as any);
					if (r === "already_placed") await (await this.harness.conversation(Number(pi.thread) as any, ctx))?.abort(ctx);
					if (r === "aborted" || r === "already_placed") n++;
				}
			}
			this.core.cancelOutboxFromRun(`run:${reply.id}`, "stopped");
			for (const child of this.core.workingMessages().filter((m) => m.meta.parentRun === `run:${reply.id}`)) n += await stopReply(child);
			return n;
		};
		const conv = this.convs.get(bindingKey({ realm: o.realmId, space: o.spaceId, agent: o.agentId }));
		let stopped = 0;
		if (conv) {
			// Working replies are stopped; finished ones may still have colleagues working on what they handed over.
			const rows = this.core.db.prepare("SELECT realm_id, id FROM messages WHERE kind = 'agent' AND json_extract(meta, '$.pi.thread') = ? ORDER BY id DESC LIMIT 20").all(String(conv.id)) as { realm_id: string; id: number }[];
			for (const row of rows) { const r = this.core.getMessage(row.realm_id, row.id); if (r) stopped += await stopReply(r); }
			await conv.abort(ctx); // also withdraws anything still queued and aborts owned helper conversations
		}
		this.core.record(o.realmId, o.by, "agent.stopped", "actor", o.agentId, { spaceId: o.spaceId, stopped });
		return { stopped };
	}

	/** Compress an agent's context with the OptChat view of its whole history. */
	async compact(o: { realmId: Id; spaceId: Id; agentId: Id; by: Id }): Promise<{ compacted: boolean }> {
		const conv = this.convs.get(bindingKey({ realm: o.realmId, space: o.spaceId, agent: o.agentId }));
		if (!conv) return { compacted: false };
		const id = await conv.compact("Replace the earlier history with the compressed memory view.", ctx);
		const done = (await this.harness.waitForTask(id, ctx)).state as any;
		const compacted = done.outcome?.status === "completed" && done.outcome?.result?.submissionId !== undefined;
		this.core.record(o.realmId, o.by, "agent.compacted", "actor", o.agentId, { spaceId: o.spaceId, compacted });
		return { compacted };
	}

	memtree(o: { realmId: Id; spaceId: Id; agentId: Id }) {
		const conv = this.convs.get(bindingKey({ realm: o.realmId, space: o.spaceId, agent: o.agentId }));
		const viewBytes = this.opts.viewBytes ?? 6000;
		if (!conv) return { leaves: 0, nodes: 0, llmNodes: 0, pending: this.builder.pending, viewBytes, view: [] };
		const thread = String(conv.id);
		const n = this.memory.leafCount(thread);
		const view = this.memory.fitView(thread, n - 1, viewBytes).map((s) => ({ id: s.idx >= 0 ? `#${s.level}.${s.idx}` : "#~", msgs: s.hi - s.lo + 1, role: s.role ?? null, text: s.text }));
		return { ...this.memory.stats(thread), pending: this.builder.pending, viewBytes, view };
	}

	/** Pi's own token and cost totals (`harness.usage()`), never a second counter of ours. */
	usage() {
		return this.harness.usage(ctx);
	}

	private setupSummarizer() {
		const ref = this.opts.summarizerModel ?? this.opts.inference.summarizer();
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

type LiveState = { current?: Message; entryId?: number; runKey?: string; view?: ConversationView; timer: NodeJS.Timeout | undefined };

/** The text and tool activity of a run, as a pure function of its transcript entries. */
export function project(entries: readonly EntryRecord[]): { text: string; activity: Step[]; failures: { entry: number; stopReason: string; error: string }[] } {
	const texts: string[] = [];
	const failures: { entry: number; stopReason: string; error: string }[] = [];
	const steps = new Map<string, Step>();
	for (const e of entries) {
		const msg: any = e.model?.[0];
		if (!msg) continue;
		if (e.kind === "pi.assistant") {
			// A generation that was interrupted (process killed mid-stream) or failed is kept by Pi as an `aborted`/`error`
			// entry and then retried. Its partial text is not part of the answer.
			if (msg.stopReason === "aborted" || msg.stopReason === "error") { failures.push({ entry: Number(e.id), stopReason: msg.stopReason, error: String(msg.errorMessage ?? "").slice(0, 300) }); continue; }
			const t = textOf(msg.content).trim();
			if (t) texts.push(t);
			for (const b of msg.content ?? []) if (b.type === "toolCall") steps.set(b.id, { id: b.id, name: b.name, args: short(b.arguments, 220), status: "running" });
		} else if (e.kind === "pi.tool-result") {
			const s = steps.get(msg.toolCallId);
			if (s) { s.status = msg.isError ? "error" : "done"; s.preview = short(textOf(msg.content), 500); }
		}
	}
	return { text: texts.join("\n\n"), activity: [...steps.values()], failures };
}

/** Say plainly why there is no answer. A full quota is the common case with metered or shared gateways. */
export function failureText(reason: string, entries: readonly EntryRecord[]): string {
	const err = [...entries].reverse().map((e: any) => e.model?.[0]).find((m: any) => m?.role === "assistant" && m.errorMessage)?.errorMessage as string | undefined;
	const raw = `${err ?? ""} ${reason}`;
	if (/quota|rate.?limit|429|too many requests|insufficient|exceeded|capacity|credit|billing/i.test(raw))
		return `⚠ The model could not answer: its quota or rate limit is used up (${(err ?? reason).slice(0, 160)}). Nothing was lost. Send the message again later, or ask an admin to pick another model for this agent.`;
	if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|timeout|timed out|unreachable/i.test(raw))
		return `⚠ The model endpoint could not be reached (${(err ?? reason).slice(0, 160)}). Nothing was lost. Send the message again when it is back.`;
	if (/abort/i.test(reason)) return "⏹ Stopped before it finished.";
	return `⚠ No answer: ${reason}${err ? ` (${err.slice(0, 200)})` : ""}. Nothing was lost; try again.`;
}
