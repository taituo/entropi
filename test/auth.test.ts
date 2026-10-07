import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/core/db.ts";
import { Core } from "../src/core/core.ts";
import { createApp } from "../src/http/app.ts";
import { config } from "../src/config.ts";

async function boot(auth: Partial<typeof config.auth>) {
	const core = new Core(openDb(":memory:"));
	core.createRealm({ id: "main", name: "Main", kind: "team" });
	const app = createApp({ core, config: { ...config, defaultRealm: "main", auth: { ...config.auth, ...auth } } });
	await new Promise<void>((r) => app.server.listen(0, r));
	after(() => app.close());
	return { core, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}
const get = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/realms/main`, { headers: { "x-requested-with": "entropi", ...headers } });

test("proxy mode: no identity header means 401; the header makes you a member with the default role", async () => {
	const { base, core } = await boot({ mode: "proxy", userHeader: "x-forwarded-user", defaultRoles: ["viewer"] });
	assert.equal((await get(base)).status, 401);
	const r = await get(base, { "x-forwarded-user": "anna@example.com" });
	assert.equal(r.status, 200);
	assert.deepEqual(core.getActor("main", "human:anna@example.com")?.roles, ["viewer"]);
});

test("proxy mode: header names are configurable; roles and display name come from headers when configured", async () => {
	const { base, core } = await boot({ mode: "proxy", userHeader: "x-auth-user", nameHeader: "x-auth-name", rolesHeader: "x-auth-roles" });
	assert.equal((await get(base, { "x-forwarded-user": "mallory" })).status, 401, "the default header name is not trusted when another is configured");
	await get(base, { "x-auth-user": "olli", "x-auth-name": "Olli O", "x-auth-roles": "operator, approver" });
	const a = core.getActor("main", "human:olli")!;
	assert.deepEqual([a.name, a.roles], ["Olli O", ["approver", "operator"]]);
	await get(base, { "x-auth-user": "olli", "x-auth-roles": "viewer,superuser" }); // unknown roles are ignored; roles follow the proxy
	assert.deepEqual(core.getActor("main", "human:olli")!.roles, ["viewer"]);
});

test("proxy mode ignores the dev cookie, and dev mode ignores the identity header", async () => {
	const proxy = await boot({ mode: "proxy" });
	const dev = await boot({ mode: "dev" });
	const login = await fetch(`${dev.base}/auth/login?as=alice`, { redirect: "manual" });
	const cookie = String(login.headers.get("set-cookie")).split(";")[0];
	assert.equal((await get(dev.base, { cookie })).status, 200);
	assert.equal((await get(proxy.base, { cookie })).status, 401);
	assert.equal((await get(dev.base, { "x-forwarded-user": "root" })).status, 401);
});

test("proxy mode: login is a no-op redirect, logout goes where configured", async () => {
	const { base } = await boot({ mode: "proxy", logoutUrl: "/oauth2/sign_out" });
	assert.equal((await fetch(`${base}/auth/login`, { redirect: "manual" })).headers.get("location"), "/");
	assert.equal((await fetch(`${base}/auth/logout`, { redirect: "manual" })).headers.get("location"), "/oauth2/sign_out");
});

test("two people whose ids start the same get different private chats, and neither can see the other's", async () => {
	const { base, core } = await boot({ mode: "proxy", defaultRoles: ["operator"] });
	core.addActor("main", { id: "agent:ops", kind: "agent", name: "Ops" }, "system");
	const call = (user: string, path: string, body?: object) => fetch(`${base}/api/v1/realms/main${path}`, { method: body ? "POST" : "GET", headers: { "x-forwarded-user": user, "x-requested-with": "entropi", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
	const a = (await call("anna@example.com", "/dms", { agent: "ops" })).body.space.id;
	const b = (await call("anna@example.org", "/dms", { agent: "ops" })).body.space.id;
	assert.notEqual(a, b, "the chat id comes from a hash of the whole identity, not its first characters");
	assert.equal((await call("anna@example.org", `/spaces/${a}/messages`)).status, 404);
	assert.equal((await call("anna@example.com", `/spaces/${b}/messages`)).status, 404);
});
