import { clip, extractive, NODE_BYTES, type OptChat, type Summarizer } from "./optchat.ts";

/**
 * Background summariser: fills the tree bottom-up, active conversations first, falling back to extractive text.
 * Its queue and pacing belong to the memory service (owned by the runtime), not to the core state machine.
 */
export class TreeBuilder {
	private queue: { thread: string; level: number; idx: number; tries: number }[] = [];
	private running = false;
	private priority = new Map<string, number>();
	readonly memory: OptChat;
	summarize?: Summarizer;
	gapMs = 1500;
	/** A summary that takes longer than this counts as failed (a hung model must not stall the queue forever). */
	summarizeTimeoutMs = 90_000;
	/** The newest this-many leaves stay verbatim in every view, so blocks touching them need no summary yet. */
	recentVerbatim = 16;
	log: (m: string) => void = () => {};

	constructor(memory: OptChat) {
		this.memory = memory;
	}

	touch(thread: string) {
		this.priority.set(thread, Date.now());
	}

	enqueue(thread: string, level: number, idx: number, tries = 0) {
		if (this.memory.nodeRow(thread, level, idx)) return;
		if (this.queue.some((q) => q.thread === thread && q.level === level && q.idx === idx)) return;
		this.queue.push({ thread, level, idx, tries });
		void this.pump();
	}

	/** After a leaf was appended: queue the newest block per level that has just become old enough to summarise. */
	onLeaf(thread: string) {
		this.touch(thread);
		const n = this.memory.leafCount(thread) - this.recentVerbatim;
		for (let level = 1; 2 ** level <= n; level++) {
			const k = Math.floor(n / 2 ** level) - 1;
			if (k >= 0) this.enqueue(thread, level, k);
		}
	}

	/** Queue every eligible block that has no summary yet (after a restart or a rebuild). */
	backfill(thread: string) {
		const n = this.memory.leafCount(thread) - this.recentVerbatim;
		const have = new Set((this.memory.db.prepare("SELECT level, idx FROM memnodes WHERE thread = ?").all(thread) as any[]).map((r) => `${r.level}:${r.idx}`));
		for (let level = 1; 2 ** level <= n; level++) for (let idx = 0; (idx + 1) * 2 ** level <= n; idx++) if (!have.has(`${level}:${idx}`)) this.enqueue(thread, level, idx);
	}

	private withTimeout<T>(p: Promise<T>): Promise<T> {
		let timer: NodeJS.Timeout;
		const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("summary timed out")), this.summarizeTimeoutMs); });
		return Promise.race([p, limit]).finally(() => clearTimeout(timer));
	}

	get pending() {
		return this.queue.length;
	}

	async idle() {
		while (this.queue.length || this.running) await new Promise((r) => setTimeout(r, 20));
	}

	private async pump() {
		if (this.running) return;
		this.running = true;
		const m = this.memory;
		try {
			while (this.queue.length) {
				this.queue.sort((a, b) => (this.priority.get(b.thread) ?? 0) - (this.priority.get(a.thread) ?? 0) || a.level - b.level || a.idx - b.idx);
				const job = this.queue.shift()!;
				if (m.nodeRow(job.thread, job.level, job.idx)) continue;
				const kids = [0, 1].map((k) => m.nodeText(job.thread, job.level - 1, job.idx * 2 + k, false));
				if (kids.some((k) => k === undefined)) {
					if (job.level > 1) {
						for (let k = 0; k < 2; k++) this.enqueue(job.thread, job.level - 1, job.idx * 2 + k);
						if (!this.queue.some((q) => q.thread === job.thread && q.level === job.level && q.idx === job.idx)) this.queue.push(job);
					} else this.log(`leaf missing under ${job.level}.${job.idx}`);
					continue;
				}
				let text: string, quality = "llm";
				try {
					text = this.summarize ? clip(await this.withTimeout(this.summarize(kids as string[], job.level)), NODE_BYTES + 40) : extractive(kids as string[]);
					if (!this.summarize) quality = "x";
					if (!text) throw new Error("empty summary");
					if (this.summarize) await new Promise((r) => setTimeout(r, this.gapMs));
				} catch (e) {
					this.log(`summary ${job.level}.${job.idx} failed (try ${job.tries + 1}): ${(e as Error).message}`);
					if (job.tries < 2) {
						this.queue.push({ ...job, tries: job.tries + 1 });
						await new Promise((r) => setTimeout(r, /rate limit/i.test((e as Error).message) ? 20_000 : this.gapMs * 2));
						continue;
					}
					text = extractive(kids as string[]);
					quality = "x";
				}
				m.putNode(job.thread, job.level, job.idx, text, quality);
			}
		} finally {
			this.running = false;
		}
	}
}
