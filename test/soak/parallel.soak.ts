// Soak 3: 5 users x 3 agents over real HTTP + SSE for SOAK_PARALLEL_MINUTES (def 15).
// SSE stays open per user; every minute one stream is cut and resumed with Last-Event-ID
// while its owner keeps posting, so replay is exercised for real. Asserts: no DM leaks
// across users, no lost committed messages per user, no duplicate SSE ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApp, type App } from "../../src/http/app.ts";
import { config } from "../../src/config.ts";
import { makeWorld, until } from "../pi-world.ts";
import { sseReader } from "../support/target.ts";
import { obs, tmpDir, soakMinutes, rssMb, fileMb, msgs } from "./support.ts";

const MINUTES = soakMinutes("SOAK_PARALLEL_MINUTES", 15);
const USERS = ["soak-u0", "soak-u1", "soak-u2", "soak-u3", "soak-u4"];
const AGENTS = ["ops", "developer", "reviewer"];
const PREFIX = "/api/realms/main";

type Conn = { reader: ReturnType<typeof sseReader>; lastId: number; seenIds: Set<number>; seenMsgs: Set<number>; drained: number };

test("soak-3: 5 users x 3 agents, SSE with Last-Event-ID resumes, no leaks, nothing lost or doubled", { timeout: 1_500_000 }, async () => {
	const t0 = Date.now();
	const end = t0 + MINUTES * 60_000;
	const dir = tmpDir("entropi-soak-3-");
	const coreDb = join(dir, "core.sqlite");
	const w = await makeWorld({ dbPath: coreDb, storage: new MemoryStorage() });
	// No pacing between background summaries: 15 threads post ~200 leaves each and the
	// default 1.5 s gap would leave a tens-of-minutes backlog still draining (and holding
	// the loop open) long after the last assertion. Same setting as soak-1/soak-2.
	w.runtime.builder.gapMs = 0;
	const cfg = { ...config, dataDir: join(dir, "data"), defaultRealm: "main", auth: { ...config.auth, mode: "proxy" as const, userHeader: "x-user", nameHeader: "", rolesHeader: "x-roles", defaultRoles: ["viewer"] } };
	const app: App = createApp({ core: w.core, config: cfg, control: () => w.runtime });
	await new Promise<void>((r) => app.server.listen(0, r));
	const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
	await w.start();

	const hdr = (u: string) => ({ "x-user": u, "x-roles": "operator", "x-requested-with": "entropi", "content-type": "application/json" });
	const call = async (u: string, method: string, path: string, body?: unknown) => {
		const res = await fetch(base + PREFIX + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
		const raw = await res.text();
		let parsed: any = null;
		try { parsed = JSON.parse(raw); } catch { /* empty */ }
		return { status: res.status, body: parsed };
	};

	// One SSE stream per user for the whole run. Opened before any DM exists (and
	// hello-waited, so registration is server-side) so every committed event streams.
	const conns = new Map<string, Conn>();
	const open = (u: string, lastId: number, carry?: Conn): Conn => {
		const reader = sseReader(base, { "x-user": u, "x-roles": "operator", ...(lastId > 0 ? { "last-event-id": String(lastId) } : {}) }, `${PREFIX}/events`);
		const c: Conn = { reader, lastId, seenIds: carry?.seenIds ?? new Set(), seenMsgs: carry?.seenMsgs ?? new Set(), drained: 0 };
		conns.set(u, c);
		return c;
	};
	for (const u of USERS) open(u, 0);
	for (const u of USERS) await conns.get(u)!.reader.until((es) => es.length > 0, 30_000);

	// Each user opens a private DM with each of the 3 agents.
	const dms = new Map<string, string[]>(); // user -> dm space ids
	for (const u of USERS) {
		const ids: string[] = [];
		for (const a of AGENTS) {
			const r = await call(u, "POST", "/dms", { agent: a });
			assert.equal(r.status, 200, `DM with ${a} for ${u}: ${JSON.stringify(r.body)}`);
			ids.push(r.body.space.id);
		}
		dms.set(u, ids);
	}
	obs("soak-3 dms", { users: USERS.length, perUser: AGENTS.length });

	const drain = (u: string) => {
		const c = conns.get(u)!;
		const fresh = c.reader.events.slice(c.drained);
		c.drained = c.reader.events.length;
		for (const e of fresh) {
			if (e.id !== undefined) {
				const n = Number(e.id);
				assert.ok(!c.seenIds.has(n), `${u}: duplicate SSE id ${n}`);
				c.seenIds.add(n);
				if (n > c.lastId) c.lastId = n;
			}
			const mid = (e.data as any)?.message?.id;
			if (e.event === "message" && typeof mid === "number") c.seenMsgs.add(mid);
		}
	};

	let rounds = 0, resumes = 0, posts = 0;
	let lastResume = Date.now();
	let rotate = 0;
	try {
		while (Date.now() < end) {
			rounds++;
			// Every user posts to every agent DM.
			for (const u of USERS) {
				for (const [ai, dm] of dms.get(u)!.entries()) {
					const marker = `s3-${u}-${AGENTS[ai]}-r${rounds}`;
					const r = await call(u, "POST", `/spaces/${dm}/messages`, { text: `@${AGENTS[ai]} ${marker} reply with just the word ok` });
					assert.equal(r.status, 200, `post ${marker}: ${r.status}`);
					posts++;
				}
			}
			// Wait for this round's answers over HTTP (what a client would read).
			const deadline = Date.now() + 120_000;
			for (const u of USERS) {
				for (const dm of dms.get(u)!) {
					const marker = `s3-${u}-`;
					for (;;) {
						const r = await call(u, "GET", `/spaces/${dm}/messages`);
						assert.equal(r.status, 200, `read ${dm}`);
						const ok = (r.body.messages as any[]).some((m: any) => m.kind === "agent" && m.status === "done" && (m.text ?? "").includes(`${marker}`) && (m.text ?? "").includes(`-r${rounds}`));
						if (ok) break;
						if (Date.now() > deadline) throw new Error(`round ${rounds}: no answer in ${dm}`);
						await new Promise((r) => setTimeout(r, 100));
					}
				}
			}
			for (const u of USERS) drain(u);

			// Every minute: cut one user's stream, keep them posting, resume with Last-Event-ID.
			if (Date.now() - lastResume > 60_000) {
				lastResume = Date.now();
				const u = USERS[rotate++ % USERS.length];
				const c = conns.get(u)!;
				c.reader.close();
				const dm = dms.get(u)![0];
				const gap = await call(u, "POST", `/spaces/${dm}/messages`, { text: `@ops s3-${u}-ops-gap-${resumes} reply with just the word ok` });
				assert.equal(gap.status, 200, "post while disconnected");
				posts++;
				const gapId = gap.body.message.id as number;
				open(u, c.lastId, c);
				resumes++;
				const nc = conns.get(u)!;
				// The replay must deliver what was missed, then the stream stays live.
				await nc.reader.until((es) => es.some((e) => (e.data as any)?.message?.id === gapId), 30_000);
				drain(u);
				assert.ok(nc.seenMsgs.has(gapId), `${u}: replayed the message posted while disconnected`);
				obs("soak-3 resume ok", { user: u, resumes, lastId: c.lastId });
			}
			if (rounds % 20 === 0) obs("soak-3 progress", { rounds, posts, resumes, rssMb: Math.round(rssMb()), minutes: Math.round((Date.now() - t0) / 60000) });
		}

		// No DM leaks: nobody sees another user's DM spaces or their content.
		for (const u of USERS) {
			const mine = new Set(dms.get(u));
			const r = await call(u, "GET", "");
			assert.equal(r.status, 200, "spaces list");
			const ids = (r.body.spaces as any[]).map((s: any) => s.id);
			for (const v of USERS) {
				if (v === u) continue;
				for (const dm of dms.get(v)!) assert.ok(!ids.includes(dm), `${u} cannot see ${v}'s DM ${dm}`);
			}
			for (const v of USERS) {
				if (v === u) continue;
				for (const dm of dms.get(v)!) {
					const o = await call(u, "GET", `/spaces/${dm}/messages`);
					if (o.status === 200) {
						const foreign = (o.body.messages as any[]).filter((m: any) => !mine.has(dm));
						assert.equal(foreign.length, 0, `${u} sees no content in ${v}'s DM (status 200)`);
						obs("soak-3 isolation note", { u, dm, status: 200, messages: (o.body.messages as any[]).length });
					} else {
						assert.equal(o.status, 404, `${u} gets 404 in ${v}'s DM (got ${o.status})`);
					}
				}
			}
		}
		// Nothing lost: every committed message in my DMs arrived on my stream.
		// (Enumerated core-direct: the HTTP listing caps at the newest 200.)
		for (const u of USERS) {
			drain(u);
			const c = conns.get(u)!;
			for (const dm of dms.get(u)!) {
				for (const m of msgs(w.core, dm, `human:${u}`)) assert.ok(c.seenMsgs.has(m.id), `${u}: message ${m.id} arrived on SSE`);
			}
			obs("soak-3 stream", { user: u, events: c.seenIds.size, messages: c.seenMsgs.size });
		}
	} finally {
		for (const c of conns.values()) c.reader.close();
		app.close();
		await w.close();
	}
	obs("soak-3 done", { minutes: Math.round((Date.now() - t0) / 60000), rounds, posts, resumes, coreDbMb: Number(fileMb(coreDb).toFixed(1)) });
	assert.ok(Date.now() - t0 >= MINUTES * 60_000, "ran the full duration");
});
