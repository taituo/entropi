import type { Context } from "@earendil-works/chord";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { TranscriptEntry, TranscriptSource } from "../../core/ports.ts";

const short = (v: unknown, n: number) => {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
const blocks = (c: any): string =>
	typeof c === "string" ? c : (c ?? []).map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join(" ");

/** A Pi transcript entry as memory text, or undefined for entries that are not conversation (system prompt, summaries, bookkeeping). */
export function leafOf(entry: Pick<EntryRecord, "kind" | "model">): (Pick<TranscriptEntry, "role" | "raw"> & { ts?: number }) | undefined {
	const msg: any = entry.model?.[0];
	if (!msg) return undefined;
	const ts = typeof msg.timestamp === "number" ? msg.timestamp : undefined; // when the message really happened, not when we rebuilt memory
	if (entry.kind === "pi.user") return { role: "user", raw: blocks(msg.content), ts };
	if (entry.kind === "pi.assistant") {
		const calls = (msg.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => `[called ${b.name}(${short(b.arguments, 90)})]`);
		return { role: "assistant", raw: [blocks(msg.content), ...calls].join(" ").trim(), ts };
	}
	if (entry.kind === "pi.tool-result") return { role: "tool", raw: `${msg.toolName ?? "tool"}: ${blocks(msg.content)}`, ts };
	return undefined;
}

/**
 * The full visible history of a Pi conversation, read with the paged `Storage.scanEntries` (not from the live watch
 * snapshot, which only carries the active transcript). Pi returns newest first, so pages are gathered and reversed.
 * Entries that a compaction replaced in the active view are still returned: that is what makes OptChat rebuildable.
 */
export class PiTranscript implements TranscriptSource {
	readonly storage: Storage;
	readonly ctx: Context;
	readonly pageSize: number;
	constructor(storage: Storage, ctx: Context, pageSize = 500) {
		this.storage = storage;
		this.ctx = ctx;
		this.pageSize = pageSize;
	}

	async *entriesAfter(thread: string, afterEntryId: number): AsyncIterable<TranscriptEntry> {
		const found: EntryRecord[] = [];
		let cursor: any;
		do {
			const page = await this.storage.scanEntries({ conversationId: Number(thread) as any, minEntryId: (afterEntryId + 1) as any }, this.pageSize, cursor, this.ctx);
			found.push(...page.items);
			cursor = page.next;
		} while (cursor);
		found.sort((a, b) => Number(a.id) - Number(b.id));
		for (const e of found) {
			const leaf = leafOf(e);
			if (leaf) yield { entryId: Number(e.id), role: leaf.role, raw: leaf.raw, ts: leaf.ts ?? Date.now() };
		}
	}
}
