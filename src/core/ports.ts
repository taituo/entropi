import type { Id } from "./types.ts";

/**
 * Ports: everything the core needs from the outside world, as interfaces. Adapters live in src/adapters and are the only
 * code allowed to import Pi, Gerrit, a workflow engine and friends. The core never imports an adapter.
 */

/** An external system that owns operational truth (workflow engine, review system, CI, cluster, session harness). */
export type SourceEvent = { workRef: { source: string; externalId: string }; state: string; at?: number; data?: Record<string, unknown> };
/** Identifies one intended effect, derived from something durable (a decision id, a runtime task id), so a replay repeats the key. */
export type InvokeContext = { idempotencyKey: string };
export interface EntropiSource {
	readonly id: string;
	/** Changes of things this source owns. Entropi caches the state and keeps the reference; the source stays authoritative. */
	observe(signal: AbortSignal): AsyncIterable<SourceEvent>;
	/** Read one external object (or a collection) on demand: `externalId` names it in the source's own scheme, `args` narrows it. */
	query?(externalId: string, args?: Record<string, unknown>): Promise<{ state: string; data?: any }>;
	/**
	 * Act on the external system. Called only after the core's policy and decision checks passed. External effects are outside any
	 * runtime's replay protection, so the key is the only guard: the same `idempotencyKey` must never execute twice. A repeated
	 * call returns what the first one returned.
	 */
	invoke?(action: string, input: any, ctx: InvokeContext): Promise<unknown>;
}

/** One transcript entry of an agent runtime, reduced to what memory needs. */
export type TranscriptEntry = { entryId: number; role: "user" | "assistant" | "tool"; raw: string; ts: number };

/** Read access to a conversation's full, ordered history. OptChat is rebuilt from this and nothing else. */
export interface TranscriptSource {
	/** Entries with entryId > afterEntryId, oldest first. */
	entriesAfter(thread: Id, afterEntryId: number): AsyncIterable<TranscriptEntry>;
}

/** Wakes an agent with a message. The runtime adapter implements it; the core and the HTTP layer only know this. */
export interface AgentDispatcher {
	dispatch(o: { realmId: Id; spaceId: Id; agentId: Id; text: string; from: Id; messageId: number; depth?: number }): Promise<void>;
}

/**
 * What a UI can ask of a running agent runtime beyond waking it, as independent abilities. A runtime implements the ones it
 * can and leaves out the rest; the API reports exactly those as capabilities and the UI shows only what is supported, so a
 * runtime other than Pi (or the scripted demo) plugs in with whatever subset it has.
 */
export interface AgentControl {
	/** Stop an agent in a space, and everything it handed on to other agents from the run in progress. */
	stop?(o: { realmId: Id; spaceId: Id; agentId: Id; by: Id }): Promise<{ stopped: number }>;
	/** Compress the agent's context with the memory tree. */
	compact?(o: { realmId: Id; spaceId: Id; agentId: Id; by: Id }): Promise<{ compacted: boolean }>;
	/** The compressed memory view and tree size of one agent in one space. */
	memtree?(o: { realmId: Id; spaceId: Id; agentId: Id }): { leaves: number; nodes: number; llmNodes: number; pending: number; viewBytes: number; view: { id: string; msgs: number; role: string | null; text: string }[] };
	/** Token and cost totals, as the runtime itself counts them. */
	usage?(): Promise<unknown>;
}
export const CAPABILITIES = ["stop", "compact", "memtree", "usage"] as const;
