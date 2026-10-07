import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { callRunner, type Endpoint, type SandboxBackend } from "./backend.ts";

export type Sandbox = { name: string; endpoint: Endpoint; token: string };
type Row = { key: string; name: string; token: string; created_at: number; last_used: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const sandboxName = (key: string) => `sbx-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;

/**
 * One sandbox per key (here: per realm and space; a private chat is a space, so it gets its own). Creates on first use,
 * reattaches after a restart of this process (the sandbox outlives it), caps how many run at once, and sweeps idle ones.
 */
export class SandboxManager {
	readonly backend: SandboxBackend;
	private db: DatabaseSync;
	private image: string;
	private max: number;
	private idleMs: number;
	private starting = new Map<string, Promise<Sandbox>>();
	private timer?: NodeJS.Timeout;

	constructor(o: { db: DatabaseSync; backend: SandboxBackend; image: string; max?: number; idleMin?: number }) {
		this.db = o.db;
		this.backend = o.backend;
		this.image = o.image;
		this.max = o.max ?? 2;
		this.idleMs = (o.idleMin ?? 30) * 60_000;
		o.db.exec("CREATE TABLE IF NOT EXISTS sandboxes (key TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL)");
	}

	private row = (key: string) => this.db.prepare("SELECT * FROM sandboxes WHERE key = ?").get(key) as Row | undefined;

	/** The running sandbox for a key, created on first use. Concurrent callers share one start. */
	ensure(key: string): Promise<Sandbox> {
		const inflight = this.starting.get(key);
		if (inflight) return inflight;
		const p = (async () => {
			const name = sandboxName(key);
			let row = this.row(key);
			let st = await this.backend.inspect(name);
			if (st.state !== "missing" && (!row || st.state === "failed")) { // untracked, or dead: start over
				await this.backend.remove(name);
				st = { state: "missing" };
			}
			if (st.state === "missing") {
				if ((await this.backend.list()).length >= this.max) throw new Error(`sandbox limit reached (${this.max} running). Ask a human to stop one, or wait for an idle one to expire.`);
				const token = randomBytes(24).toString("base64url");
				await this.backend.start({ name, key, token, image: this.image });
				this.db.prepare("INSERT OR REPLACE INTO sandboxes (key, name, token, created_at, last_used) VALUES (?,?,?,?,?)").run(key, name, token, Date.now(), Date.now());
				row = this.row(key);
			}
			for (let i = 0; i < 90; i++) {
				st = await this.backend.inspect(name);
				if (st.state === "failed") throw new Error(`sandbox failed to start: ${st.detail ?? ""}`);
				if (st.state === "running" && st.endpoint && (await callRunner(st.endpoint, row!.token, "GET", "/health", undefined, 2000).then(() => true, () => false))) break;
				await sleep(300);
			}
			if (st.state !== "running" || !st.endpoint) throw new Error("sandbox did not become ready in time");
			this.db.prepare("UPDATE sandboxes SET last_used = ? WHERE key = ?").run(Date.now(), key);
			return { name, endpoint: st.endpoint, token: row!.token };
		})().finally(() => this.starting.delete(key));
		this.starting.set(key, p);
		return p;
	}

	call<T = any>(sb: Sandbox, method: "GET" | "POST" | "PUT", path: string, body?: string | object, timeoutMs?: number): Promise<T> {
		return callRunner<T>(sb.endpoint, sb.token, method, path, body, timeoutMs);
	}

	async stop(key: string): Promise<boolean> {
		const row = this.row(key);
		await this.backend.remove(row?.name ?? sandboxName(key));
		this.db.prepare("DELETE FROM sandboxes WHERE key = ?").run(key);
		return !!row;
	}

	list() {
		return (this.db.prepare("SELECT * FROM sandboxes ORDER BY created_at").all() as Row[]).map((r) => ({ key: r.key, name: r.name, createdAt: r.created_at, lastUsed: r.last_used }));
	}

	/** Remove sandboxes idle too long, and any the backend has that nobody tracks any more. */
	async sweep() {
		for (const r of this.db.prepare("SELECT * FROM sandboxes WHERE last_used < ?").all(Date.now() - this.idleMs) as Row[]) await this.stop(r.key);
		const tracked = new Set((this.db.prepare("SELECT name FROM sandboxes").all() as { name: string }[]).map((r) => r.name));
		for (const name of await this.backend.list().catch(() => [])) if (!tracked.has(name)) await this.backend.remove(name);
	}

	startSweeper(everyMs = 60_000) {
		this.timer = setInterval(() => void this.sweep().catch((e) => console.warn("[sandbox] sweep failed:", e.message)), everyMs);
		this.timer.unref();
	}

	stopSweeper() {
		clearInterval(this.timer);
	}
}
