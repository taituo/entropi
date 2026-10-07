// One way to drive the HTTP API, either in-process (offline, deterministic: `npm test`) or against a running deployment
// (`npm run test:cluster`, ENTROPI_URL set). Suites written against Target run unchanged in both.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/core/db.ts";
import { Core } from "../../src/core/core.ts";
import { createApp, type App } from "../../src/http/app.ts";
import { config } from "../../src/config.ts";
import type { AgentControl } from "../../src/core/ports.ts";

export type Role = "viewer" | "operator" | "approver" | "admin";
export const ROLES: Role[] = ["viewer", "operator", "approver", "admin"];
export type Res = { status: number; body: any; headers: Headers; raw: Buffer };
export type SseEvent = { id?: string; event: string; data: any };

export interface Target {
	mode: "offline" | "cluster";
	/** A user per role. The cluster's dev login has no admin. */
	users: Partial<Record<Role, string>>;
	/** Only offline: the core behind the app. */
	core?: Core;
	calls: { stop: any[]; compact: any[]; sandboxStop: string[] };
	call(user: string, method: string, path: string, body?: unknown, o?: { raw?: Buffer | string; headers?: Record<string, string>; ctype?: string; csrf?: boolean }): Promise<Res>;
	sse(user: string, o?: { lastEventId?: string; query?: string }): { events: SseEvent[]; close(): void; until(fn: (e: SseEvent[]) => boolean, ms?: number): Promise<void> };
	close(): Promise<void>;
}

const PREFIX = "/api/realms/main";
const ROLE_USERS: Record<Role, string> = { viewer: "vera", operator: "olga", approver: "alma", admin: "adam" };
const CLUSTER_USERS: Partial<Record<Role, string>> = { viewer: "carol", operator: "bob", approver: "alice" };

export async function target(): Promise<Target> {
	const url = process.env.ENTROPI_URL?.replace(/\/$/, "");
	return url ? clusterTarget(url) : offlineTarget();
}

export function sseReader(base: string, headers: Record<string, string>, path: string) {
	const events: SseEvent[] = [];
	let buf = "";
	const req = request(base + path, { headers });
	req.on("response", (res) => {
		res.setEncoding("utf8");
		res.on("data", (chunk: string) => {
			buf += chunk;
			for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
				const block = buf.slice(0, i); buf = buf.slice(i + 2);
				const f: Record<string, string> = {};
				for (const line of block.split("\n")) { const k = line.indexOf(": "); if (k > 0) f[line.slice(0, k)] = line.slice(k + 2); }
				if (f.event) events.push({ id: f.id, event: f.event, data: f.data ? JSON.parse(f.data) : null });
			}
		});
	});
	req.on("error", () => {});
	req.end();
	return {
		events, close: () => req.destroy(),
		async until(fn: (e: SseEvent[]) => boolean, ms = 5000) {
			const t = Date.now();
			while (!fn(events)) { if (Date.now() - t > ms) throw new Error(`sse: condition not met; saw ${events.map((e) => e.event).join(",")}`); await new Promise((r) => setTimeout(r, 15)); }
		},
	};
}

async function offlineTarget(): Promise<Target> {
	const core = new Core(openDb(":memory:"));
	core.createRealm({ id: "main", name: "Main", kind: "team" });
	core.addActor("main", { id: "agent:ops", kind: "agent", name: "Ops" }, "system");
	core.addActor("main", { id: "agent:developer", kind: "agent", name: "Developer" }, "system");
	core.createSpace("main", { id: "general", kind: "standing", name: "general", agentIds: ["agent:ops", "agent:developer"] }, "system");
	const calls: Target["calls"] = { stop: [], compact: [], sandboxStop: [] };
	const control: AgentControl = {
		stop: async (o) => { calls.stop.push(o); return { stopped: 1 }; },
		compact: async (o) => { calls.compact.push(o); return { compacted: true }; },
		memtree: () => ({ leaves: 0, nodes: 0, llmNodes: 0, pending: 0, viewBytes: 0, view: [] }),
		usage: async () => ({ models: {}, tools: {} }),
	};
	const cfg = { ...config, dataDir: `/tmp/entropi-test-${process.pid}-${Date.now()}`, defaultRealm: "main", auth: { ...config.auth, mode: "proxy" as const, userHeader: "x-user", nameHeader: "", rolesHeader: "x-roles", defaultRoles: ["viewer"] } };
	const app: App = createApp({ core, config: cfg, control: () => control, sandboxes: () => ({ list: () => [], stop: async (k) => { calls.sandboxStop.push(k); return true; } }) });
	await new Promise<void>((r) => app.server.listen(0, r));
	const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
	const roleOf = (u: string) => Object.entries(ROLE_USERS).find(([, v]) => v === u)?.[0] ?? "viewer";
	const hdr = (u: string) => ({ "x-user": u, "x-roles": roleOf(u) });
	return {
		mode: "offline", users: ROLE_USERS, core, calls,
		async call(user, method, path, body, o = {}) {
			const res = await fetch(base + (!/^\/(api|auth|healthz)(\/|$)/.test(path) && (path === "" || path.startsWith("/")) ? PREFIX + path : path), {
				method, headers: { ...hdr(user), ...(o.csrf === false ? {} : { "x-requested-with": "entropi" }), "content-type": o.ctype ?? "application/json", ...o.headers },
				body: (o.raw ?? (body === undefined ? undefined : JSON.stringify(body))) as any,
			});
			const raw = Buffer.from(await res.arrayBuffer());
			let parsed: any = null; try { parsed = JSON.parse(raw.toString()); } catch { /* binary or empty */ }
			return { status: res.status, body: parsed, headers: res.headers, raw };
		},
		sse: (user, o = {}) => sseReader(base, { ...hdr(user), ...(o.lastEventId ? { "last-event-id": o.lastEventId } : {}) }, `${PREFIX}/events${o.query ?? ""}`),
		async close() { app.close(); },
	};
}

async function clusterTarget(base: string): Promise<Target> {
	const cookies = new Map<string, string>();
	const login = async (u: string) => {
		if (cookies.has(u)) return cookies.get(u)!;
		for (let i = 0; i < 30; i++) {
			try {
				const r = await fetch(`${base}/auth/login?as=${u}`, { redirect: "manual" });
				const c = String(r.headers.get("set-cookie") ?? "").split(";")[0];
				if (c) { cookies.set(u, c); return c; }
			} catch { /* pod restarting */ }
			await new Promise((r) => setTimeout(r, 2000));
		}
		throw new Error(`cannot log in as ${u} at ${base}`);
	};
	const users = CLUSTER_USERS;
	return {
		mode: "cluster", users, calls: { stop: [], compact: [], sandboxStop: [] },
		async call(user, method, path, body, o = {}) {
			const cookie = await login(user);
			const res = await fetch(base + (/^\/(api|auth|healthz)(\/|$)/.test(path) ? path : PREFIX + path), {
				method, headers: { cookie, ...(o.csrf === false ? {} : { "x-requested-with": "entropi" }), "content-type": o.ctype ?? "application/json", ...o.headers },
				body: (o.raw ?? (body === undefined ? undefined : JSON.stringify(body))) as any,
			});
			const raw = Buffer.from(await res.arrayBuffer());
			let parsed: any = null; try { parsed = JSON.parse(raw.toString()); } catch { /* binary or empty */ }
			return { status: res.status, body: parsed, headers: res.headers, raw };
		},
		sse: (user, o = {}) => {
			const u = new URL(base);
			const handle = { events: [] as SseEvent[], close: () => {}, until: (async (_fn: (e: SseEvent[]) => boolean, _ms?: number) => {}) as (fn: (e: SseEvent[]) => boolean, ms?: number) => Promise<void> };
			// the cookie is async; resolve it before connecting
			const ready = login(user).then((cookie) => {
				const r = sseReader(u.origin, { cookie, ...(o.lastEventId ? { "last-event-id": o.lastEventId } : {}) }, `${PREFIX}/events${o.query ?? ""}`);
				handle.events = r.events; handle.close = r.close; handle.until = r.until;
			});
			return {
				get events() { return handle.events; },
				close: () => handle.close(),
				until: async (fn: (e: SseEvent[]) => boolean, ms?: number) => { await ready; return handle.until(fn, ms); },
			} as any;
		},
		async close() {},
	};
}

/** Create a DM for an operator, or find it again. */
export async function dmOf(t: Target, user: string, agent = "ops"): Promise<string> {
	const r = await t.call(user, "POST", "/dms", { agent });
	if (r.status !== 200) throw new Error(`dm: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body.space.id;
}
export async function caseOf(t: Target, user: string, topic: string): Promise<string> {
	const r = await t.call(user, "POST", "/spaces", { topic });
	if (r.status !== 200) throw new Error(`case: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body.space.id;
}
