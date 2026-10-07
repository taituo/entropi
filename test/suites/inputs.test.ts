// Wrong and hostile input at the API door: sizes, types, prototype keys, path tricks, fake images. The answer is always a
// plain 4xx with a message, never a 500, never a crash, never somebody else's data.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { target, type Target } from "../support/target.ts";

let t: Target;
before(async () => { t = await target(); });
after(() => t.close());
const op = () => t.users.operator!;
const post = (body: unknown, o: any = {}) => t.call(op(), "POST", "/spaces/general/messages", body, o);
const raw = (s: string | Buffer, ctype = "application/json") => t.call(op(), "POST", "/spaces/general/messages", undefined, { raw: s, ctype });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
const noServerError = (r: { status: number }, what: string) => assert.ok(r.status < 500, `${what}: got ${r.status}`);

test("inputs: bodies that are not objects get a 400, never a 500", async () => {
	for (const body of ["null", "123", '"just a string"', "[]", "[1,2]", "true", "{", "", "{\"text\":", "\u0000", "{'text':'x'}"]) {
		const r = await raw(body);
		noServerError(r, `body ${JSON.stringify(body)}`);
		assert.ok(r.status === 400 || r.status === 415, `body ${JSON.stringify(body)} -> ${r.status}`);
	}
});

test("inputs: message text: the wrong types, the empty, the too long, the odd", async () => {
	for (const text of [{}, [], 123, true, null, ["a"], { toString: "x" }, "", "   ", "\n\t "]) {
		const r = await post({ text });
		noServerError(r, `text ${JSON.stringify(text)}`);
		assert.ok([200, 400].includes(r.status), `text ${JSON.stringify(text)} -> ${r.status}`);
		if (typeof text !== "string") assert.equal(r.status, 400, `a ${typeof text} is not a message: ${JSON.stringify(text)}`);
		if (typeof text === "string" && !text.trim()) assert.equal(r.status, 400);
	}
	assert.equal((await post({ text: "x".repeat(4001) })).status, 400, "4001 characters");
	assert.equal((await post({ text: "x".repeat(4000) })).status, 200, "exactly 4000 is fine");
	assert.equal((await post({ text: "é".repeat(3000) + "😀".repeat(500) })).status, 200, "unicode counts characters, not bytes");
	assert.equal((await post({ text: "a\u0000b" })).status < 500, true, "NUL inside text");
	assert.equal((await raw(JSON.stringify({ text: "x".repeat(70_000) }))).status, 413, "a body over 64 KB");
});

test("inputs: extra and hostile keys are ignored; prototype keys change nothing", async () => {
	const r = await raw('{"text":"proto probe","__proto__":{"admin":true,"roles":["admin"]},"constructor":{"prototype":{"x":1}},"mode":"__proto__","attachments":"nope"}');
	assert.equal(r.status, 200);
	assert.equal(({} as any).admin, undefined, "Object.prototype was not polluted");
	assert.equal(({} as any).x, undefined);
	assert.equal((await t.call(t.users.viewer!, "POST", "/dms", { agent: "ops" })).status, 403, "still a viewer");
	for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype", "valueOf"]) {
		for (const path of [`/spaces/${id}/messages`, `/spaces/${id}/agents/ops/stop`, `/spaces/general/agents/${id}/stop`, `/spaces/general/agents/${id}/memtree`, `/files/${id}`, `/decisions/${id}/decide`]) {
			const m = path.includes("stop") || path.includes("decide") ? "POST" : "GET";
			const res = await t.call(op(), m, path, m === "POST" ? { answer: "approve" } : undefined);
			noServerError(res, `${m} ${path}`);
			assert.ok([400, 404].includes(res.status), `${m} ${path} -> ${res.status}`);
		}
		assert.equal((await t.call(op(), "POST", "/dms", { agent: id })).status, 400, `DM with agent "${id}"`);
	}
	assert.equal((await t.call(op(), "GET", "/api/v1/realms/__proto__")).status, 404);
	assert.equal((await t.call(op(), "GET", "/api/v1/realms/constructor/spaces")).status, 404);
});

test("inputs: attachments: not a list, too many, repeated, unknown, wrong types", async () => {
	for (const attachments of ["abc", 5, {}, null, true]) assert.ok((await post({ text: "a", attachments })).status < 500, `attachments ${JSON.stringify(attachments)}`);
	assert.equal((await post({ text: "a", attachments: ["a", "b", "c", "d", "e"] })).status, 400, "more than four");
	assert.equal((await post({ text: "a", attachments: ["0".repeat(32)] })).status, 400, "an id that does not exist");
	assert.equal((await post({ text: "a", attachments: [{ id: "x" }, 7, null, ["z"]] })).status, 400, "ids that are not ids");
	assert.equal((await post({ text: "a", attachments: ["../../etc/passwd"] })).status, 400);
	const up = await t.call(op(), "POST", "/spaces/general/upload?name=a.png", undefined, { raw: Buffer.concat([PNG, Buffer.from("dup-" + Math.random())]), ctype: "image/png" });
	const id = up.body.attachment.id;
	assert.equal((await post({ text: "same twice", attachments: [id, id, id] })).status < 500, true);
});

test("inputs: uploads: only real images, decided by the bytes; names cannot escape; size limits hold", async () => {
	const up = (bytes: Buffer | string, ctype = "image/png", name = "x.png") => t.call(op(), "POST", `/spaces/general/upload?name=${encodeURIComponent(name)}`, undefined, { raw: bytes, ctype });
	// the label says image, the bytes say text / html / svg / pdf / exe / zip / script
	for (const [what, bytes] of [["text", "just text"], ["html", "<html><script>alert(1)</script></html>"], ["svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], ["pdf", "%PDF-1.4 ..."], ["exe", Buffer.from("MZ\x90\x00", "latin1")], ["zip", Buffer.from("PK\x03\x04", "latin1")], ["empty", ""], ["png header only", PNG.subarray(0, 8)], ["a lone 0xff", Buffer.from([0xff])]] as const) {
		const r = await up(bytes as any);
		assert.equal(r.status, 415, `${what} labelled image/png -> ${r.status}`);
	}
	// the label says text, the bytes say PNG: the bytes win, and the stored type is image/png
	const real = await up(Buffer.concat([PNG, Buffer.from("t" + Math.random())]), "text/html", "evil.html");
	assert.equal(real.status, 200);
	assert.equal(real.body.attachment.mime, "image/png");
	const file = await t.call(op(), "GET", `/files/${real.body.attachment.id}`);
	assert.equal(file.headers.get("content-type"), "image/png");
	assert.equal(file.headers.get("x-content-type-options"), "nosniff");
	assert.match(String(file.headers.get("content-security-policy")), /default-src 'none'/);
	// a PNG with HTML appended is still just served as image/png with a locked-down CSP
	const poly = await up(Buffer.concat([PNG, Buffer.from("<script>alert(1)</script>" + Math.random())]));
	assert.equal(poly.status, 200);
	assert.equal((await t.call(op(), "GET", `/files/${poly.body.attachment.id}`)).headers.get("content-type"), "image/png");
	// names: traversal, markup, control characters, very long
	for (const name of ["../../../../etc/passwd", "..\\..\\windows\\system32", "<script>alert(1)</script>.png", "a\r\nSet-Cookie: x=1", "x".repeat(5000) + ".png", "%00.png", "con.png"]) {
		const r = await up(Buffer.concat([PNG, Buffer.from(name.slice(0, 20) + Math.random())]), "image/png", name);
		assert.equal(r.status, 200, `name ${name.slice(0, 30)}`);
		assert.ok(!/[<>/\\\r\n]/.test(r.body.attachment.name), `the stored name is plain: ${JSON.stringify(r.body.attachment.name)}`);
		assert.ok(r.body.attachment.name.length <= 80);
	}
	// sizes: a large file is refused with a clear message, not accepted and not a crash; and images in one message are limited in total
	const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 7)]);
	const r = await up(big);
	assert.equal(r.status, 413);
	assert.match(String(r.body?.error), /too large|max/);
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		const x = await up(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, i + 1)]));
		assert.equal(x.status, 200);
		ids.push(x.body.attachment.id);
	}
	const total = await post({ text: "twelve megabytes", attachments: ids });
	assert.equal(total.status, 413);
	assert.match(String(total.body.error), /10 MB/);
	assert.equal((await post({ text: "nine megabytes", attachments: ids.slice(0, 3) })).status, 200);
});

test("inputs: file and static paths cannot be walked out of", async () => {
	for (const p of ["/files/..%2f..%2fetc%2fpasswd", "/files/../../etc/passwd", "/files/" + "a".repeat(31), "/files/" + "g".repeat(32), "/files/" + "A".repeat(32), "/files/%00"]) {
		const r = await t.call(op(), "GET", p.startsWith("/files") ? p : p);
		assert.ok([404, 400].includes(r.status), `${p} -> ${r.status}`);
	}
	for (const p of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/package.json", "/public/../package.json", "/vendor/../../package.json", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "//etc/passwd", "/..\\package.json", "/vendor/preact.js/../../package.json", "/.git/config", "/.deploy.env", "/node_modules/typescript/package.json"]) {
		const r = await t.call(op(), "GET", p);
		const leaked = r.raw.toString().includes('"name": "entropi"') || r.raw.toString().includes("root:x:") || r.raw.toString().includes("LOCAL_LLM");
		assert.equal(leaked, false, `${p} leaked a file`);
		assert.ok(r.status < 500, `${p} -> ${r.status}`);
	}
});

test("inputs: decisions: answers and notes of the wrong type or size", async (ctx) => {
	if (t.mode !== "offline") return ctx.skip("needs a decision created by the test");
	const core = t.core!;
	core.createWork("main", { id: "w-in", kind: "a", title: "in", ownerId: "agent:ops", spaceId: "general", state: "working" }, "agent:ops");
	const d = core.requestDecision("main", { key: "k-in", workId: "w-in", question: "q" }, "agent:ops").decision;
	const a = "approver:inputs";
	for (const body of [{}, { answer: null }, { answer: 5 }, { answer: {} }, { answer: [] }, { answer: "" }, { answer: "APPROVE" }, { answer: "approve ", note: {} }]) {
		const r = await t.call(a, "POST", `/decisions/${d.id}/decide`, body);
		noServerError(r, JSON.stringify(body));
		assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
	}
	assert.equal(core.getDecision("main", d.id)!.status, "open", "none of those decided anything");
	const ok = await t.call(a, "POST", `/decisions/${d.id}/decide`, { answer: "approve", note: "n".repeat(5000) });
	assert.equal(ok.status, 200);
	assert.equal(ok.body.decision.note.length, 300, "the note is cut to 300 characters");
});

test("inputs: odd query strings and ids do not break reads", async () => {
	for (const p of ["/events/log?after=abc", "/events/log?after=-1", "/events/log?after=1e99", "/events/log?after[]=1", "/spaces/general/messages?limit=-5", "/spaces/%/messages", "/spaces/ /messages", "/spaces/" + "a".repeat(5000) + "/messages", "/spaces//messages", "/spaces/general/messages/", "/focus?x=" + "y".repeat(5000)]) {
		const r = await t.call(t.users.approver!, "GET", p);
		noServerError(r, p);
	}
});

test("inputs: the identity header is bounded and cannot impersonate an agent or another realm member", async (ctx) => {
	if (t.mode !== "offline") return ctx.skip("the cluster signs people in with its own login");
	for (const sub of ["agent:ops", "system", "human:alma", "x".repeat(2000), "a b c", "../../x", "<b>x</b>", "ünïcødé", "ops'; DROP TABLE actors;--"]) {
		const r = await t.call(sub, "GET", "");
		noServerError(r, `user ${sub.slice(0, 30)}`);
		if (r.status === 200) {
			assert.equal(r.body.me.kind, "human", "a person, whatever the header says");
			assert.ok(r.body.me.id.startsWith("human:"));
			assert.notEqual(r.body.me.id, "agent:ops");
			assert.ok(!r.body.me.roles.includes("admin") || sub.startsWith("admin"), "no roles from nowhere");
		}
	}
	assert.equal((await t.call("x".repeat(201), "GET", "")).status, 400, "an id of 201 characters is refused");
	assert.equal((await t.call("x".repeat(200), "GET", "")).status, 200);
	const agentLike = await t.call("agent:ops", "POST", "/spaces/general/messages", { text: "i am the agent" });
	assert.equal(agentLike.status === 200 ? agentLike.body.message.authorId : "refused", agentLike.status === 200 ? "human:agent:ops" : "refused");
	// role header with junk
	const weird = await t.call("viewer:weird", "GET", "", undefined, { headers: { "x-roles": "__proto__,constructor,toString, ,admin2,ADMIN" } });
	assert.ok(weird.status < 500);
	assert.ok(!weird.body?.me?.roles?.includes("admin"), `junk roles grant nothing: ${JSON.stringify(weird.body?.me?.roles)}`);
});
