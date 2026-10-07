// experimental: front desk router teaching-data store (off unless ENTROPI_EXPERIMENTAL_ROUTER=1).
/**
 * Routing corrections ("ei, developer") as teaching/measurement data. The core stays out of it: corrections are
 * not domain facts, so they live in the adapter's own store (memory for tests, a JSONL file in production),
 * never in raw SQL and never as new event types.
 */

export type Correction = {
	at: number;
	by: string;
	spaceId: string;
	/** The human message that was misrouted (or the correction text when the original is unknown). */
	text: string;
	routedTo: string;
	correctedTo: string;
};

export interface FeedbackStore {
	record(c: Correction): void | Promise<void>;
	list(): Correction[] | Promise<Correction[]>;
}

export class MemoryFeedback implements FeedbackStore {
	readonly corrections: Correction[] = [];
	record(c: Correction): void {
		this.corrections.push(c);
	}
	list(): Correction[] {
		return [...this.corrections];
	}
}

export class FileFeedback implements FeedbackStore {
	private path: string;
	constructor(path: string) {
		this.path = path;
	}
	async record(c: Correction): Promise<void> {
		const { appendFile, mkdir } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(c)}\n`, "utf8");
	}
	async list(): Promise<Correction[]> {
		const { readFile } = await import("node:fs/promises");
		try {
			const raw = await readFile(this.path, "utf8");
			return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Correction);
		} catch {
			return [];
		}
	}
}
