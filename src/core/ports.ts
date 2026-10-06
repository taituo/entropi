import type { Id } from "./types.ts";

/**
 * Ports: everything the core needs from the outside world, as interfaces. Adapters live in src/adapters and are the only
 * code allowed to import Pi, Gerrit, a workflow engine and friends. The core never imports an adapter.
 */

/** An external system that owns operational truth (workflow engine, review system, CI, session harness). */
export type SourceEvent = { workRef: { source: string; externalId: string }; state: string; at?: number; data?: Record<string, unknown> };
export interface EntropiSource {
	readonly id: string;
	/** Changes of things this source owns. Entropi caches the state and keeps the reference; the source stays authoritative. */
	observe(signal: AbortSignal): AsyncIterable<SourceEvent>;
	/** Read the current state of one external object on demand. */
	query?(externalId: string): Promise<{ state: string; data?: Record<string, unknown> }>;
	/** Act on the external system. Called only after the core's policy and decision checks passed. */
	invoke?(action: string, input: unknown): Promise<unknown>;
}

/** One transcript entry of an agent runtime, reduced to what memory needs. */
export type TranscriptEntry = { entryId: number; role: "user" | "assistant" | "tool"; raw: string; ts: number };

/** Read access to a conversation's full, ordered history. OptChat is rebuilt from this and nothing else. */
export interface TranscriptSource {
	/** Entries with entryId > afterEntryId, oldest first. */
	entriesAfter(thread: Id, afterEntryId: number): AsyncIterable<TranscriptEntry>;
}
