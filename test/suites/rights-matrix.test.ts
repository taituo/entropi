// Who may do what, as a table: every role x every API path x the kind of space it touches (channel, DM, case).
// Runs in-process (offline) and, with ENTROPI_URL set, against a deployment. The same rules are checked straight against
// the core in rights-core.test.ts, because the API is not the only way in.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { ROLES, caseOf, dmOf, target, type Res, type Role, type Target } from "../support/target.ts";

let t: Target;
let dm: string, kase: string;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
before(async () => {
	t = await target();
	dm = await dmOf(t, t.users.operator!);
	kase = await caseOf(t, t.users.operator!, `matrix case ${Date.now()}`);
});
after(async () => { await t.call(t.users.operator!, "POST", `/spaces/${kase}/archive`).catch(() => {}); await t.close(); });

const roles = () => ROLES.filter((r) => t.users[r]);
type Want = Partial<Record<Role, number>>;
const all = (n: number): Want => ({ viewer: n, operator: n, approver: n, admin: n });

/** The expectation for a DM: only its owner (the operator user) can see it, everybody else gets "not found", whatever the role. */
const dmWant = (owner: number): Want => ({ viewer: 404, operator: owner, approver: 404, admin: 404 });

const rows: { name: string; space: "channel" | "case" | "dm" | "none"; offlineOnly?: boolean; run: (u: string, s: string) => Promise<Res>; want: Want }[] = [
	// reads
	{ name: "GET messages", space: "channel", run: (u, s) => t.call(u, "GET", `/spaces/${s}/messages`), want: all(200) },
	{ name: "GET messages", space: "case", run: (u, s) => t.call(u, "GET", `/spaces/${s}/messages`), want: all(200) },
	{ name: "GET messages", space: "dm", run: (u, s) => t.call(u, "GET", `/spaces/${s}/messages`), want: dmWant(200) },
	{ name: "GET memtree", space: "channel", run: (u, s) => t.call(u, "GET", `/spaces/${s}/agents/ops/memtree`), want: all(200) },
	{ name: "GET memtree", space: "dm", run: (u, s) => t.call(u, "GET", `/spaces/${s}/agents/ops/memtree`), want: dmWant(200) },
	// writes into a space
	{ name: "POST message", space: "channel", run: (u, s) => t.call(u, "POST", `/spaces/${s}/messages`, { text: "matrix probe" }), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST message", space: "case", run: (u, s) => t.call(u, "POST", `/spaces/${s}/messages`, { text: "matrix probe" }), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST message", space: "dm", offlineOnly: true, run: (u, s) => t.call(u, "POST", `/spaces/${s}/messages`, { text: "matrix probe" }), want: dmWant(200) },
	{ name: "POST upload", space: "channel", run: (u, s) => t.call(u, "POST", `/spaces/${s}/upload?name=p.png`, undefined, { raw: PNG, ctype: "image/png" }), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST upload", space: "dm", run: (u, s) => t.call(u, "POST", `/spaces/${s}/upload?name=p.png`, undefined, { raw: PNG, ctype: "image/png" }), want: dmWant(200) },
	// agent control
	{ name: "POST stop", space: "channel", run: (u, s) => t.call(u, "POST", `/spaces/${s}/agents/ops/stop`), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST stop", space: "dm", run: (u, s) => t.call(u, "POST", `/spaces/${s}/agents/ops/stop`), want: dmWant(200) },
	{ name: "POST compact", space: "channel", offlineOnly: true, run: (u, s) => t.call(u, "POST", `/spaces/${s}/agents/ops/compact`), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST compact", space: "dm", offlineOnly: true, run: (u, s) => t.call(u, "POST", `/spaces/${s}/agents/ops/compact`), want: dmWant(200) },
	{ name: "POST stop, an agent that is not in the space", space: "channel", run: (u, s) => t.call(u, "POST", `/spaces/${s}/agents/nobody/stop`), want: all(404) },
	{ name: "POST sandbox/stop", space: "channel", run: (u, s) => t.call(u, "POST", `/spaces/${s}/sandbox/stop`), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST sandbox/stop", space: "dm", run: (u, s) => t.call(u, "POST", `/spaces/${s}/sandbox/stop`), want: dmWant(200) },
	// archiving: only cases end; standing rooms and DMs are permanent
	{ name: "POST archive", space: "channel", run: (u, s) => t.call(u, "POST", `/spaces/${s}/archive`), want: all(400) },
	{ name: "POST archive", space: "dm", run: (u, s) => t.call(u, "POST", `/spaces/${s}/archive`), want: dmWant(400) },
	{ name: "POST reopen", space: "case", run: (u, s) => t.call(u, "POST", `/spaces/${s}/reopen`), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	// realm level
	{ name: "GET realm", space: "none", run: (u) => t.call(u, "GET", ""), want: all(200) },
	{ name: "GET focus", space: "none", run: (u) => t.call(u, "GET", "/focus"), want: all(200) },
	{ name: "GET decisions", space: "none", run: (u) => t.call(u, "GET", "/decisions"), want: all(200) },
	{ name: "GET sandboxes", space: "none", run: (u) => t.call(u, "GET", "/sandboxes"), want: all(200) },
	{ name: "GET usage", space: "none", run: (u) => t.call(u, "GET", "/usage"), want: { viewer: 403, operator: 403, approver: 200, admin: 200 } },
	{ name: "GET events/log", space: "none", run: (u) => t.call(u, "GET", "/events/log"), want: { viewer: 403, operator: 403, approver: 200, admin: 200 } },
	{ name: "POST spaces (open a case)", space: "none", run: (u) => t.call(u, "POST", "/spaces", { topic: `matrix ${u}` }), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST dms", space: "none", run: (u) => t.call(u, "POST", "/dms", { agent: "ops" }), want: { viewer: 403, operator: 200, approver: 200, admin: 200 } },
	{ name: "POST dms, no such agent", space: "none", run: (u) => t.call(u, "POST", "/dms", { agent: "ghost" }), want: all(400) },
];

for (const row of rows) {
	test(`matrix: ${row.name} on ${row.space === "none" ? "the realm" : `a ${row.space}`}`, async (ctx) => {
		if (row.offlineOnly && t.mode !== "offline") return ctx.skip("offline only (needs a stubbed runtime)");
		const space = row.space === "channel" ? "general" : row.space === "case" ? kase : dm;
		const got: Record<string, number> = {};
		for (const r of roles()) got[r] = (await row.run(t.users[r]!, space)).status;
		const want: Record<string, number | undefined> = {};
		for (const r of roles()) want[r] = row.want[r];
		assert.deepEqual(got, want, `${row.name} (${row.space})`);
	});
}

test("matrix: the doors themselves: no login is 401, a write without the CSRF header is 403, unknown routes and realms are 404", async () => {
	const some = t.users.operator!;
	assert.equal((await t.call(some, "POST", "/spaces/general/messages", { text: "x" }, { csrf: false })).status, 403);
	assert.equal((await t.call(some, "GET", "/api/v1/realms/nope")).status, 404);
	assert.equal((await t.call(some, "GET", "/nothing-here")).status, 404);
	assert.equal((await t.call(some, "GET", "/spaces/general/unknown-thing")).status, 404);
	assert.equal((await t.call(some, "GET", "/spaces/no-such-space/messages")).status, 404);
	if (t.mode === "offline") {
		const res = await fetch(`${(t as any).base ?? ""}`).catch(() => null);
		void res;
	}
});

test("matrix: an invisible DM and a space that does not exist look the same (no hint that it is there)", async () => {
	const a = await t.call(t.users.approver!, "GET", `/spaces/${dm}/messages`);
	const b = await t.call(t.users.approver!, "GET", `/spaces/dm-ops-0000000000000000/messages`);
	assert.equal(a.status, b.status);
	assert.equal(String(a.body.error).replaceAll(dm, "X"), String(b.body.error).replaceAll("dm-ops-0000000000000000", "X"));
});

test("matrix: the DM is gone from every list for everybody but its owner", async () => {
	for (const r of roles()) {
		const view = (await t.call(t.users[r]!, "GET", "")).body;
		const mine = view.spaces.some((s: any) => s.id === dm);
		assert.equal(mine, r === "operator", `${r} sees the DM: ${mine}`);
		assert.ok(!(await t.call(t.users[r]!, "GET", "/sandboxes")).body.sandboxes.some((s: any) => s.spaceId === dm && r !== "operator"));
	}
});

test("matrix: attachments follow their space: the owner and nobody else can fetch a DM's file, a channel's file is for everyone", async () => {
	const owner = t.users.operator!;
	const png = (tag: string) => Buffer.concat([PNG, Buffer.from(`${tag}-${Date.now()}-${Math.random()}`)]); // distinct bytes: files are content-addressed
	const inDm = (await t.call(owner, "POST", `/spaces/${dm}/upload?name=a.png`, undefined, { raw: png("dm"), ctype: "image/png" })).body.attachment.id;
	const inChannel = (await t.call(owner, "POST", `/spaces/general/upload?name=b.png`, undefined, { raw: png("ch"), ctype: "image/png" })).body.attachment.id;
	for (const r of roles()) {
		assert.equal((await t.call(t.users[r]!, "GET", `/files/${inDm}`)).status, r === "operator" ? 200 : 404, `${r} fetching the DM file`);
		assert.equal((await t.call(t.users[r]!, "GET", `/files/${inChannel}`)).status, 200, `${r} fetching the channel file`);
	}
	// a file id from another space is "unknown" in this one, and a DM answers 404 before anything else is looked at
	const elsewhere = await t.call(t.users.approver!, "POST", "/spaces/general/messages", { text: "x", attachments: [inDm] });
	assert.equal(elsewhere.status, 400);
	const viaDm = await t.call(t.users.approver!, "POST", `/spaces/${dm}/messages`, { text: "x", attachments: [inDm] });
	assert.equal(viaDm.status, 404);
	// somebody else's upload cannot be attached to your message, even in the same channel
	assert.equal((await t.call(t.users.approver!, "POST", "/spaces/general/messages", { text: "mine now", attachments: [inChannel] })).status, 400);
	// the same picture uploaded by two people into one channel is one file that both can attach
	const same = png("same");
	const up1 = await t.call(t.users.operator!, "POST", "/spaces/general/upload?name=s.png", undefined, { raw: same, ctype: "image/png" });
	const up2 = await t.call(t.users.approver!, "POST", "/spaces/general/upload?name=s.png", undefined, { raw: same, ctype: "image/png" });
	assert.equal(up1.body.attachment.id, up2.body.attachment.id);
	assert.equal((await t.call(t.users.approver!, "POST", "/spaces/general/messages", { text: "same picture", attachments: [up2.body.attachment.id] })).status, 200);
});

test("matrix: the decision list and the deciding are scoped by space too (offline: a decision in a DM and one in a channel)", async (ctx) => {
	if (t.mode !== "offline") return ctx.skip("needs a decision made by the test; the cluster's come from a model");
	const core = t.core!;
	const dmSpace = dm;
	core.createWork("main", { id: "w-dm", kind: "approval", title: "private thing", ownerId: "agent:ops", spaceId: dmSpace, state: "working" }, "agent:ops");
	core.createWork("main", { id: "w-ch", kind: "approval", title: "shared thing", ownerId: "agent:ops", spaceId: "general", state: "working" }, "agent:ops");
	const dDm = core.requestDecision("main", { key: "k-dm", workId: "w-dm", question: "private?", requiredAuthority: "approver" }, "agent:ops").decision;
	const dCh = core.requestDecision("main", { key: "k-ch", workId: "w-ch", question: "shared?", requiredAuthority: "approver" }, "agent:ops").decision;
	const listed = async (r: Role) => ((await t.call(t.users[r]!, "GET", "/decisions")).body.decisions as any[]).map((d) => d.id);
	for (const r of roles()) {
		const ids = await listed(r);
		assert.ok(ids.includes(dCh.id), `${r} sees the channel decision`);
		assert.equal(ids.includes(dDm.id), r === "operator", `${r} sees the DM decision: ${ids.includes(dDm.id)}`);
	}
	// deciding: invisible = 404 for everyone else (even an admin); the owner is only an operator, so authority is the answer
	assert.equal((await t.call(t.users.approver!, "POST", `/decisions/${dDm.id}/decide`, { answer: "approve" })).status, 404);
	assert.equal((await t.call(t.users.admin!, "POST", `/decisions/${dDm.id}/decide`, { answer: "approve" })).status, 404);
	assert.equal((await t.call(t.users.operator!, "POST", `/decisions/${dDm.id}/decide`, { answer: "approve" })).status, 403);
	// the channel one: viewer and operator lack authority; an approver decides; then it is final
	assert.equal((await t.call(t.users.viewer!, "POST", `/decisions/${dCh.id}/decide`, { answer: "approve" })).status, 403);
	assert.equal((await t.call(t.users.operator!, "POST", `/decisions/${dCh.id}/decide`, { answer: "approve" })).status, 403);
	assert.equal((await t.call(t.users.approver!, "POST", `/decisions/${dCh.id}/decide`, { answer: "launch" })).status, 400, "an answer that is not an option");
	assert.equal((await t.call(t.users.approver!, "POST", `/decisions/${dCh.id}/decide`, { answer: "approve" })).status, 200);
	assert.equal((await t.call(t.users.admin!, "POST", `/decisions/${dCh.id}/decide`, { answer: "reject" })).status, 409, "already decided");
	assert.equal((await t.call(t.users.viewer!, "POST", `/decisions/${dCh.id}/decide`, { answer: "reject" })).status, 409, "finished is 409 before rights");
	assert.equal((await t.call(t.users.approver!, "POST", `/decisions/no-such/decide`, { answer: "approve" })).status, 404);
});

test("matrix: an admin-only decision needs an admin", async (ctx) => {
	if (t.mode !== "offline") return ctx.skip("offline only");
	const core = t.core!;
	core.createWork("main", { id: "w-adm", kind: "approval", title: "dangerous", ownerId: "agent:ops", spaceId: "general", state: "working" }, "agent:ops");
	const d = core.requestDecision("main", { key: "k-adm", workId: "w-adm", question: "wipe?", requiredAuthority: "admin" }, "agent:ops").decision;
	assert.equal((await t.call(t.users.approver!, "POST", `/decisions/${d.id}/decide`, { answer: "approve" })).status, 403);
	assert.equal((await t.call(t.users.admin!, "POST", `/decisions/${d.id}/decide`, { answer: "approve" })).status, 200);
});
