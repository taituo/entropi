import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.ts";
import { Core } from "../src/core/core.ts";
import { createApp } from "../src/http/app.ts";
import { config } from "../src/config.ts";
import type { AgentDispatcher } from "../src/core/ports.ts";
import { DispatchPump } from "../src/runtime/pump.ts";

const core = new Core(openDb(":memory:"));
core.createRealm({ id: "main", name: "Main", kind: "team" });
core.addActor("main", { id: "agent:ops", kind: "agent", name: "Ops" }, "system");
core.addActor("main", { id: "agent:dev", kind: "agent", name: "Developer" }, "system");
core.createSpace("main", { id: "general", kind: "standing", name: "general", agentIds: ["agent:ops"] }, "system");

const dispatched: any[] = [];
const dispatcher: AgentDispatcher = { async dispatch(o) { dispatched.push(o); } };
const cfg = { ...config, auth: { ...config.auth, mode: "dev" as const }, defaultRealm: "main" };
const controlCalls: any[] = [];
const control = {
	stop: async (o: any) => { controlCalls.push(["stop", o.agentId, o.by]); return { stopped: 1 }; },
	compact: async (o: any) => { controlCalls.push(["compact", o.agentId]); return { compacted: true }; },
	memtree: () => ({ leaves: 3, nodes: 1, llmNodes: 1, pending: 0, viewBytes: 6000, view: [] }),
	usage: async () => ({ models: {}, tools: {} }),
};
const sbxList = [{ key: "main:general", createdAt: 1, lastUsed: 2 }, { key: "main:dm-ops-dev-alice", createdAt: 1, lastUsed: 2 }];
const stopped: string[] = [];
const app = createApp({ core, config: cfg, control: () => control, sandboxes: () => ({ list: () => sbxList, stop: async (k: string) => { stopped.push(k); return true; } }) });
const pump = new DispatchPump(core, dispatcher);
pump.start();
await new Promise<void>((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { pump.stop(); app.close(); });

async function login(as: string) {
	const res = await fetch(`${base}/auth/login?as=${as}`, { redirect: "manual" });
	return String(res.headers.get("set-cookie")).split(";")[0];
}
const call = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
	const res = await fetch(base + path, { method, headers: { cookie, "x-requested-with": "entropi", "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const alice = await login("alice"), bob = await login("bob"), carol = await login("carol");

/** Minimal SSE reader: collects {id,event,data} until closed. */
function sse(cookie: string, path: string, headers: Record<string, string> = {}) {
	const events: { id?: string; event: string; data: any }[] = [];
	const req = request(base + path, { headers: { cookie, ...headers } });
	let buf = "";
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
	return { events, close: () => req.destroy() };
}
const until = async (fn: () => boolean, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

test("the API needs a session, and writes need the CSRF header", async () => {
	assert.equal((await fetch(`${base}/api/me`)).status, 401);
	assert.equal((await fetch(`${base}/`, { redirect: "manual" })).status, 302);
	assert.equal((await call(alice, "POST", "/api/realms/main/spaces/general/messages", { text: "hi" }, { "x-requested-with": "" })).status, 403);
});

test("signing in joins the realm with the roles the identity provider gave", async () => {
	const me = await call(alice, "GET", "/api/me");
	assert.equal(me.body.user.id, "human:dev-alice");
	assert.deepEqual(me.body.realms.map((r: any) => r.id), ["main"]);
	const realm = await call(carol, "GET", "/api/realms/main");
	assert.deepEqual(realm.body.me.roles, ["viewer"]);
	assert.equal((await call(alice, "GET", "/api/realms/nope")).status, 404);
});

test("posting: viewers cannot, operators can; @mentions wake only agents present; unknown ones get a notice", async () => {
	assert.equal((await call(carol, "POST", "/api/realms/main/spaces/general/messages", { text: "hi" })).status, 403);
	dispatched.length = 0;
	const r = await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "@ops look, and @dev too" });
	assert.equal(r.status, 200);
	assert.deepEqual(r.body.dispatchedTo, ["agent:ops"]);
	await pump.idle(); await until(() => dispatched.length === 1);
	assert.deepEqual(dispatched.map((d) => [d.agentId, d.from]), [["agent:ops", "human:dev-bob"]]);
	const msgs = (await call(carol, "GET", "/api/realms/main/spaces/general/messages")).body.messages;
	assert.match(msgs.at(-1).text, /dev is not in #general/);
	assert.equal((await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "x".repeat(4001) })).status, 400);
});

test("a private chat answers every message and is invisible to others, over HTTP and over SSE", async () => {
	const made = await call(alice, "POST", "/api/realms/main/dms", { agent: "ops" });
	assert.equal(made.status, 200);
	const id = made.body.space.id;
	const bobStream = sse(bob, "/api/realms/main/events");
	const aliceStream = sse(alice, "/api/realms/main/events");
	await until(() => bobStream.events.length > 0 && aliceStream.events.length > 0);
	dispatched.length = 0;
	const r = await call(alice, "POST", `/api/realms/main/spaces/${id}/messages`, { text: "no mention needed" });
	assert.deepEqual(r.body.dispatchedTo, ["agent:ops"]);
	assert.equal((await call(bob, "GET", `/api/realms/main/spaces/${id}/messages`)).status, 404);
	assert.equal((await call(bob, "POST", `/api/realms/main/spaces/${id}/messages`, { text: "peek" })).status, 404);
	assert.ok(!(await call(bob, "GET", "/api/realms/main")).body.spaces.some((s: any) => s.id === id));
	await until(() => aliceStream.events.some((e) => e.event === "message" && e.data.message.text === "no mention needed"));
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(!JSON.stringify(bobStream.events).includes("no mention needed"), "Bob's stream never carried Anna's DM");
	assert.ok(!JSON.stringify(bobStream.events).includes(id));
	bobStream.close(); aliceStream.close();
});

test("SSE resumes from Last-Event-ID without gaps or duplicates", async () => {
	const s1 = sse(bob, "/api/realms/main/events");
	await until(() => s1.events.some((e) => e.event === "hello"));
	await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "one" });
	await until(() => s1.events.some((e) => e.data?.message?.text === "one"));
	const lastId = s1.events.filter((e) => e.id).at(-1)!.id!;
	s1.close();
	await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "two (while offline)" });
	await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "three" });
	const s2 = sse(bob, "/api/realms/main/events", { "last-event-id": lastId });
	await until(() => s2.events.some((e) => e.data?.message?.text === "three"));
	const texts = s2.events.filter((e) => e.event === "message").map((e) => e.data.message.text);
	assert.deepEqual(texts, ["two (while offline)", "three"]);
	await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "four" });
	await until(() => s2.events.some((e) => e.data?.message?.text === "four"));
	const ids = s2.events.filter((e) => e.id).map((e) => Number(e.id));
	assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b), "ordered, no duplicates");
	s2.close();
});

test("approving over HTTP: only approvers, first wins, the card updates for everybody who can see it", async () => {
	core.createWork("main", { id: "w1", kind: "fix", title: "checkout", state: "working", spaceId: "general" }, "agent:ops");
	const { decision } = core.requestDecision("main", { key: "apply-1", workId: "w1", question: "Apply POOL_SIZE=4?", context: { target: "checkout-api" } }, "agent:ops");
	const stream = sse(carol, "/api/realms/main/events");
	await until(() => stream.events.length > 0);
	assert.equal((await call(bob, "POST", `/api/realms/main/decisions/${decision.id}/decide`, { answer: "approve" })).status, 403, "an operator cannot approve");
	assert.equal((await call(alice, "POST", `/api/realms/main/decisions/${decision.id}/decide`, { answer: "approve", note: "ok" })).status, 200);
	assert.equal((await call(alice, "POST", `/api/realms/main/decisions/${decision.id}/decide`, { answer: "reject" })).status, 409);
	await until(() => stream.events.some((e) => e.event === "message" && e.data.message.meta?.status === "decided"));
	const card = stream.events.filter((e) => e.event === "message").map((e) => e.data.message).find((m) => m.kind === "decision" && m.meta.status === "decided");
	assert.equal(card.meta.decidedBy, "Alice (approver)");
	stream.close();
});

test("focus over HTTP is the person's own small view", async () => {
	core.createWork("main", { id: "w2", kind: "fix", title: "second", state: "working", spaceId: "general" }, "agent:ops");
	core.requestDecision("main", { key: "apply-2", workId: "w2", question: "Second?" }, "agent:ops");
	assert.equal((await call(alice, "GET", "/api/realms/main/focus")).body.focus.needsYou.length, 1);
	assert.equal((await call(bob, "GET", "/api/realms/main/focus")).body.focus.needsYou.length, 0);
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const upload = (cookie: string, space: string, bytes: Buffer, name = "dot.png") =>
	fetch(`${base}/api/realms/main/spaces/${space}/upload?name=${name}`, { method: "POST", headers: { cookie, "x-requested-with": "entropi", "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) });

test("images: only real images, size limits, visibility follows the space, and the message carries them", async () => {
	const r = await upload(alice, "general", PNG);
	assert.equal(r.status, 200);
	const att = ((await r.json()) as any).attachment;
	assert.equal(att.mime, "image/png");
	assert.equal((await upload(alice, "general", Buffer.from("not an image at all"))).status, 415);
	assert.equal((await upload(carol, "general", PNG)).status, 403, "viewers cannot post, so cannot upload");
	assert.equal((await upload(alice, "general", Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).status, 413);

	const posted = await call(alice, "POST", "/api/realms/main/spaces/general/messages", { text: "see this", attachments: [att.id] });
	assert.equal(posted.status, 200);
	assert.deepEqual(posted.body.message.meta.images.map((i: any) => i.id), [att.id]);
	assert.equal((await call(alice, "POST", "/api/realms/main/spaces/general/messages", { text: "x", attachments: ["0".repeat(32)] })).status, 400);
	assert.equal((await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "stolen", attachments: [att.id] })).status, 400, "someone else's upload cannot be attached");
	const file = await fetch(`${base}/api/realms/main/files/${att.id}`, { headers: { cookie: carol } });
	assert.equal(file.status, 200);
	assert.equal(file.headers.get("content-type"), "image/png");
});

test("an image shared in a private chat is invisible to everybody else", async () => {
	const dm = await call(alice, "POST", "/api/realms/main/dms", { agent: "ops" });
	const att = ((await (await upload(alice, dm.body.space.id, Buffer.concat([PNG, Buffer.from("dm-only")]), "secret.png")).json()) as any).attachment;
	assert.equal((await fetch(`${base}/api/realms/main/files/${att.id}`, { headers: { cookie: alice } })).status, 200);
	assert.equal((await fetch(`${base}/api/realms/main/files/${att.id}`, { headers: { cookie: bob } })).status, 404);
	assert.equal((await upload(bob, dm.body.space.id, PNG)).status, 404);
});

test("stop, compact, memory view and usage: who may, and only for agents you can see", async () => {
	const stop = (c: string, space: string, agent: string) => call(c, "POST", `/api/realms/main/spaces/${space}/agents/${agent}/stop`, {});
	assert.equal((await stop(carol, "general", "ops")).status, 403, "viewers cannot stop");
	const ok = await stop(bob, "general", "ops");
	assert.deepEqual([ok.status, ok.body.stopped], [200, 1]);
	assert.deepEqual(controlCalls.at(-1), ["stop", "agent:ops", "human:dev-bob"]);
	assert.equal((await stop(bob, "general", "developer")).status, 404, "developer is not in #general in this test realm");
	assert.equal((await call(bob, "POST", "/api/realms/main/spaces/general/agents/ops/compact", {})).body.compacted, true);
	assert.equal((await call(carol, "GET", "/api/realms/main/spaces/general/agents/ops/memtree")).body.leaves, 3, "anyone who sees the space can look at the memory view");
	const dm = (await call(alice, "POST", "/api/realms/main/dms", { agent: "ops" })).body.space.id;
	assert.equal((await stop(bob, dm, "ops")).status, 404, "nobody else can reach into a private chat");
	assert.equal((await call(bob, "GET", "/api/realms/main/usage")).status, 403);
	assert.deepEqual((await call(alice, "GET", "/api/realms/main/usage")).body.usage, { models: {}, tools: {} });
});

test("sandboxes: listed only for spaces you can see; stopping needs the operator role and a visible space", async () => {
	const dm = (await call(alice, "POST", "/api/realms/main/dms", { agent: "ops" })).body.space.id;
	sbxList[1].key = `main:${dm}`;
	assert.deepEqual((await call(bob, "GET", "/api/realms/main/sandboxes")).body.sandboxes.map((x: any) => x.spaceId), ["general"], "someone else's private chat sandbox is not listed");
	assert.deepEqual((await call(alice, "GET", "/api/realms/main/sandboxes")).body.sandboxes.map((x: any) => x.spaceId), ["general", dm]);
	assert.equal((await call(carol, "POST", "/api/realms/main/spaces/general/sandbox/stop", {})).status, 403);
	assert.equal((await call(bob, "POST", `/api/realms/main/spaces/${dm}/sandbox/stop`, {})).status, 404);
	assert.equal((await call(bob, "POST", "/api/realms/main/spaces/general/sandbox/stop", {})).status, 200);
	assert.deepEqual(stopped, ["main:general"]);
});

test("a person can choose to steer: the message carries the choice, and nothing else changes", async () => {
	const steered = await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "@ops change course", mode: "steer" });
	assert.equal(steered.body.message.meta.steer, true);
	const plain = await call(bob, "POST", "/api/realms/main/spaces/general/messages", { text: "@ops just this" });
	assert.equal(plain.body.message.meta.steer, undefined);
});

test("the same rules behind the UI: a private chat's decision is a 404 for others; syncing identity on every request writes nothing", async () => {
	const dm = (await call(alice, "POST", "/api/realms/main/dms", { agent: "ops" })).body.space.id;
	core.createWork("main", { id: "alice-private", kind: "x", title: "private", state: "working", spaceId: dm }, "agent:ops");
	const { decision } = core.requestDecision("main", { key: "alice-private-q", workId: "alice-private", question: "Private?", requiredAuthority: "operator" }, "agent:ops");
	assert.equal((await call(bob, "POST", `/api/realms/main/decisions/${decision.id}/decide`, { answer: "approve" })).status, 404, "bob is an operator and could decide it, but it does not exist for him");
	assert.equal(core.getDecision("main", decision.id)!.status, "open");
	const before = core.events("main").length;
	for (let i = 0; i < 5; i++) { await call(alice, "GET", "/api/me"); await call(bob, "GET", "/api/realms/main/focus"); }
	assert.equal(core.events("main").length, before, "no event per request");
});

test("capabilities: the API reports exactly what the connected runtime can do, and unsupported actions are refused plainly", async () => {
	const caps = (await call(alice, "GET", "/api/realms/main")).body.capabilities;
	assert.deepEqual(caps, { stop: true, compact: true, memtree: true, usage: true, sandboxes: true });
	// another runtime that only knows how to stop and report usage
	const partial: any = { stop: control.stop, usage: control.usage };
	const core2 = new Core(openDb(":memory:"));
	core2.createRealm({ id: "main", name: "Main", kind: "team" });
	core2.createSpace("main", { id: "general", kind: "standing", name: "general" }, "system");
	const app2 = createApp({ core: core2, config: cfg, control: () => partial });
	await new Promise<void>((r) => app2.server.listen(0, r));
	try {
		const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;
		const login2 = String((await fetch(`${base2}/auth/login?as=alice`, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0];
		const c2 = (m: string, p: string) => fetch(base2 + p, { method: m, headers: { cookie: login2, "x-requested-with": "entropi", "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
		assert.deepEqual((await c2("GET", "/api/realms/main")).body.capabilities, { stop: true, compact: false, memtree: false, usage: true, sandboxes: false });
		core2.addActor("main", { id: "agent:x", kind: "agent", name: "X" }, "system");
		core2.createSpace("main", { id: "room", kind: "case", name: "room", agentIds: ["agent:x"] }, "system");
		assert.equal((await c2("POST", "/api/realms/main/spaces/room/agents/x/compact")).status, 501, "unsupported: refused, not faked");
		assert.equal((await c2("GET", "/api/realms/main/spaces/room/agents/x/memtree")).body.unavailable, true);
		assert.equal((await c2("POST", "/api/realms/main/spaces/room/agents/x/stop")).status, 200);
	} finally { app2.close(); }
});
