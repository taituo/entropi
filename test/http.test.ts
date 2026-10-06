import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.ts";
import { Core } from "../src/core/core.ts";
import { createApp } from "../src/http/app.ts";
import { config } from "../src/config.ts";
import type { AgentDispatcher } from "../src/core/ports.ts";

const core = new Core(openDb(":memory:"));
core.createRealm({ id: "main", name: "Main", kind: "team" });
core.addActor("main", { id: "agent:ops", kind: "agent", name: "Ops" });
core.addActor("main", { id: "agent:dev", kind: "agent", name: "Developer" });
core.createSpace("main", { id: "general", kind: "standing", name: "general", agentIds: ["agent:ops"] }, "system");

const dispatched: any[] = [];
const dispatcher: AgentDispatcher = { async dispatch(o) { dispatched.push(o); } };
const cfg = { ...config, auth: { ...config.auth, mode: "dev" as const }, defaultRealm: "main" };
const app = createApp({ core, config: cfg, dispatcher });
await new Promise<void>((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => app.close());

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
