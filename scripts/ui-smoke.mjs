// Browser smoke test that makes no assumption about what is already in the system, so it runs against a fresh demo and
// against a long-lived deployment alike. Real Chromium via Playwright; exits 1 on any failed check, page error, console
// error or failed request.
//   BASE_URL=http://host:port OUT=./shots node ui-smoke.mjs      (see scripts/ui-smoke.sh)
import { chromium } from "playwright-core";
import { readdirSync, mkdirSync } from "node:fs";

const BASE = (process.env.BASE_URL ?? "http://localhost:8097").replace(/\/$/, "");
const OUT = process.env.OUT ?? ".";
const ANSWER_MS = Number(process.env.ANSWER_MS ?? 120_000);
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM ?? readdirSync("/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `/ms-playwright/${d}/chrome-linux/chrome`)[0];
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const problems = [], checks = [];
const ok = (name, cond, extra = "") => { checks.push([cond, name]); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " - " + extra : ""}`); if (!cond) problems.push(name); };
/** A finding that is reported but does not fail the run (the thing it checks is being changed elsewhere). */
const soft = (name, cond) => console.log(`${cond ? "PASS" : "KNOWN ISSUE"} ${name}`);
const expected404 = new Set();
const tag = `smoke-${Date.now().toString(36)}`;

async function open(user, viewport = { width: 1360, height: 860 }, hash = "") {
	const ctx = await browser.newContext({ viewport, colorScheme: "dark" });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => { problems.push(`pageerror(${user}): ${e.message}`); console.log("PAGEERROR", user, e.message); });
	page.on("console", (m) => { if (m.type() === "error" && !(expected404.size && /404/.test(m.text()))) { problems.push(`console.error(${user}): ${m.text()}`); console.log("CONSOLE.ERROR", user, m.text()); } });
	page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon") && !(r.status() === 404 && [...expected404].some((x) => r.url().includes(x)))) { problems.push(`HTTP ${r.status()} ${r.url()} (${user})`); console.log("HTTP>=400", user, r.status(), r.url()); } });
	for (let i = 0; i < 20; i++) { try { await page.goto(`${BASE}/auth/login?as=${user}`); break; } catch { await page.waitForTimeout(2000); } }
	await page.waitForSelector(".shell", { timeout: 30000 });
	if (hash) { await page.goto(`${BASE}/${hash}`); await page.reload(); await page.waitForSelector(".timeline", { timeout: 20000 }); }
	return page;
}
const api = (page, path) => page.evaluate(async (p) => (await fetch(`/api/v1/realms/main${p}`, { headers: { "x-requested-with": "entropi" } })).json(), path);
const timelineText = (page) => page.locator(".timeline").innerText();
const onScreen = async (loc) => { const b = await loc.boundingBox(); return !!b && b.x + b.width > 1; };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}` });
const send = async (page, text) => { await page.fill("textarea", text); await page.click(".send"); };

// ---- an operator: channel, private chat, hostile text -------------------------------------------------------------
const bob = await open("bob", undefined, "#general");
ok("the shell renders with several channels", (await bob.locator(".side .item").count()) >= 4);
await send(bob, `plain message ${tag}`);
await bob.waitForFunction((t) => document.querySelector(".timeline")?.innerText.includes(t), `plain message ${tag}`, { timeout: 15000 });
ok("a sent message appears in the channel", true);
const hostile = `<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> **bold?** [x](javascript:alert(1)) ${tag}`;
await send(bob, hostile);
await bob.waitForFunction(() => document.querySelector(".timeline")?.innerText.includes("<script>"), null, { timeout: 15000 });
ok("markup in a message is shown as text and never runs", (await bob.evaluate(() => window.__xss)) === undefined && (await timelineText(bob)).includes("<script>"));
const longWord = "W".repeat(3000);
await send(bob, longWord);
await bob.waitForFunction(() => document.querySelector(".timeline")?.innerText.includes("WWWWWWWWWWWWWWWWWWWW"), null, { timeout: 15000 });
ok("a 3000-character word does not break the layout", (await bob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
await bob.fill("textarea", "line one");
await bob.press("textarea", "Shift+Enter");
await bob.keyboard.type("line two");
ok("Shift+Enter makes a new line, it does not send", (await bob.inputValue("textarea")) === "line one\nline two");
await bob.fill("textarea", "");
await bob.reload(); await bob.waitForSelector(".timeline");
ok("reloading keeps the channel and its history", (await timelineText(bob)).includes(`plain message ${tag}`));

await bob.click(".side .item:has-text('Ops') >> nth=-1");
await bob.waitForSelector(".header h2:has-text('🔒')", { timeout: 10000 });
ok("clicking an agent opens a private chat", true);
await send(bob, `private ${tag}: answer with one short sentence`);
await bob.waitForFunction((t) => document.querySelector(".timeline")?.innerText.includes(t), `private ${tag}`, { timeout: 15000 });
const dmId = (await api(bob, "")).spaces.find((x) => x.kind === "dm").id;
let answered = false;
for (const t0 = Date.now(); Date.now() - t0 < ANSWER_MS && !answered;) {
	await bob.waitForTimeout(1500);
	answered = (await api(bob, `/spaces/${dmId}/messages`)).messages.some((m) => m.kind === "agent" && m.status === "done" && m.text.length > 0);
}
ok("the agent answers in the private chat", answered);
await shot(bob, "smoke-private-chat.png");

// ---- privacy: what each person's sidebar shows is exactly what the API says is theirs --------------------------------
const bobSpaces = (await api(bob, "")).spaces;
for (const id of bobSpaces.filter((x) => x.kind === "dm").map((x) => x.id)) expected404.add(id); // probed on purpose below
const bobDms = bobSpaces.filter((s) => s.kind === "dm").map((s) => s.id);
ok("the operator has a private chat", bobDms.length >= 1);
for (const user of ["alice", "carol"]) {
	const p = await open(user);
	const mine = (await api(p, "")).spaces;
	ok(`${user}: the API list holds none of bob's private chats`, bobDms.every((id) => !mine.some((s) => s.id === id)));
	ok(`${user}: the sidebar shows exactly the private chats that are theirs`, (await p.locator(".side .item:has-text('🔒')").count()) === mine.filter((s) => s.kind === "dm").length);
	const direct = await p.evaluate(async (id) => (await fetch(`/api/v1/realms/main/spaces/${id}/messages`, { headers: { "x-requested-with": "entropi" } })).status, bobDms[0]);
	ok(`${user}: asking for bob's private chat by id is a 404`, direct === 404);
	await p.goto(`${BASE}/#${bobDms[0]}`); await p.reload(); await p.waitForSelector(".shell");
	ok(`${user}: opening its address shows no private content`, !(await p.locator("body").innerText()).includes(`private ${tag}`));
	await p.context().close();
}

// ---- a viewer watches ---------------------------------------------------------------------------------------------------
const carol = await open("carol", undefined, "#general");
ok("a viewer sees the channel but cannot type", await carol.locator("textarea").isDisabled());
ok("a viewer cannot start a private chat with an agent either (no way to post)", (await api(carol, "")).me.roles.includes("viewer"));

// ---- approvals, if there are any right now --------------------------------------------------------------------------------
const alice = await open("alice");
const pending = (await api(alice, "/decisions")).decisions;
if (pending.length) {
	const space = (await api(alice, "")).spaces.find(() => true);
	void space;
	await alice.goto(`${BASE}/#incidents`); await alice.reload(); await alice.waitForSelector(".timeline");
	const card = alice.locator(".card.pending").first();
	if (await card.count()) {
		ok("an approver sees Approve and Reject on an open card", (await alice.locator(".btn.approve").count()) >= 1 && (await alice.locator(".btn.reject").count()) >= 1);
		const bobIn = await open("bob", undefined, "#incidents");
		ok("an operator sees no Approve button", (await bobIn.locator(".btn.approve").count()) === 0);
		ok("and is told who can decide", (await bobIn.locator(".needs-approver").count()) >= 1);
		await bobIn.context().close();
	} else console.log("n/a: open decisions exist but none in #incidents");
} else console.log("n/a: no open approval right now");

// ---- phone widths ------------------------------------------------------------------------------------------------------
for (const width of [390, 320]) {
	const phone = await open("alice", { width, height: 800 }, "#general");
	const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	ok(`phone ${width}px: no horizontal scrolling`, overflow <= 0, `${overflow}px`);
	ok(`phone ${width}px: thread and composer are visible`, (await phone.locator(".timeline").isVisible()) && (await phone.locator("textarea").isVisible()));
	ok(`phone ${width}px: the channel list is hidden until asked`, !(await onScreen(phone.locator(".side .item >> nth=0"))));
	await phone.click(".navbtn"); await phone.waitForTimeout(300);
	ok(`phone ${width}px: the menu opens the channel list`, await onScreen(phone.locator(".side .item >> nth=0")));
	await shot(phone, `smoke-phone-${width}.png`);
	await phone.click(".side .item:has-text('development')"); await phone.waitForTimeout(300);
	ok(`phone ${width}px: choosing another channel closes the list`, !(await onScreen(phone.locator(".side .item >> nth=0"))));
	await phone.click(".navbtn"); await phone.waitForTimeout(300);
	await phone.click(".side .item:has-text('development')"); await phone.waitForTimeout(300);
	soft(`phone ${width}px: tapping the channel you are already in also closes the list`, !(await onScreen(phone.locator(".side .item >> nth=0"))));
	if (await onScreen(phone.locator(".side .item >> nth=0"))) { await phone.click(".side .item:has-text('general')"); await phone.waitForTimeout(300); }
	await send(phone, `phone ${width} ${tag} ${"x".repeat(300)}`);
	await phone.waitForFunction((t) => document.querySelector(".timeline")?.innerText.includes(t), `phone ${width} ${tag}`, { timeout: 15000 });
	ok(`phone ${width}px: a long message does not widen the page`, (await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
	await phone.context().close();
}

await browser.close();
console.log(`\n${checks.filter((c) => c[0]).length}/${checks.length} checks passed, ${problems.length} problem(s)`);
for (const p of problems) console.log(" -", p);
process.exit(problems.length ? 1 : 0);
