// Drives the REAL UI in a real browser (Chromium via Playwright), checks what a person would see, and writes screenshots.
//
//   AUTH_MODE=dev DATA_DIR=/tmp/e PORT=8097 PUBLIC_URL=http://localhost:8097 node src/server.ts &
//   podman run --rm --network=host -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.55.0-noble \
//     bash -c 'mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core@1.55.0 >/dev/null 2>&1 && cp /work/scripts/ui-check.mjs . && BASE_URL=http://localhost:8097 OUT=/work/docs/img node ui-check.mjs'
//
// Fails (exit 1) on any page error, console error, failed request or missing element, so "the UI works" is a measured claim.
import { chromium } from "playwright-core";
import { readdirSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = process.env.BASE_URL ?? "http://localhost:8097";
const OUT = process.env.OUT ?? ".";
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM ?? readdirSync("/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `/ms-playwright/${d}/chrome-linux/chrome`)[0];
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

const problems = [];
const checks = [];
const ok = (name, cond, extra = "") => { checks.push([cond, name]); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " - " + extra : ""}`); if (!cond) problems.push(name); };

const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, [r, g, b]) {
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

async function open(user, viewport = { width: 1360, height: 860 }) {
	const ctx = await browser.newContext({ viewport, colorScheme: "dark" });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => { problems.push(`pageerror(${user}): ${e.message}`); console.log("PAGEERROR", user, e.message); });
	page.on("console", (m) => { if (m.type() === "error") { problems.push(`console.error(${user}): ${m.text()}`); console.log("CONSOLE.ERROR", user, m.text()); } });
	page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) { const e = `HTTP ${r.status()} ${r.url()}`;  problems.push(`${e} (${user})`); console.log("HTTP>=400", user, r.status(), r.url()); } });
	await page.goto(`${BASE}/auth/login?as=${user}`);
	await page.waitForSelector(".shell", { timeout: 20000 });
	return page;
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}` });
const sleep = (p, ms) => p.waitForTimeout(ms);
/** Playwright counts an element slid off-screen as "visible"; what matters is whether any of it is on screen. */
const onScreen = async (loc) => { const b = await loc.boundingBox(); return !!b && b.x + b.width > 1; };

// --- Bob (operator) asks Ops in #incidents -------------------------------------------------------------
const bob = await open("bob");
ok("shell renders with brand and channels", (await bob.locator(".side .item").count()) >= 5);
await bob.goto(`${BASE}/#incidents`); await bob.reload(); await bob.waitForSelector(".timeline .notice");
await bob.fill("textarea", "@ops checkout-api kaatuu, korjaa");
await bob.click(".send");
await bob.waitForSelector(".timeline .card.pending", { timeout: 30000 });
ok("an approval card appears for the operator", true);
ok("operator sees that only an approver can decide", (await bob.locator(".needs-approver").count()) === 1);
ok("operator has no approve button", (await bob.locator(".btn.approve").count()) === 0);
ok("agent activity steps are shown", (await bob.locator(".activity").count()) >= 1);
ok("focus panel lists what needs people", /pending approval/i.test(await bob.locator(".ctx-pin").innerText()));
await sleep(bob, 600);
await shot(bob, "ui-01-operator-sees-approval.png");

// --- Alice (approver) approves it ------------------------------------------------------------------------
const alice = await open("alice");
await alice.goto(`${BASE}/#incidents`); await alice.reload(); await alice.waitForSelector(".timeline .card.pending");
ok("approver sees Approve and Reject", (await alice.locator(".btn.approve").count()) === 1 && (await alice.locator(".btn.reject").count()) === 1);
ok("the needs-you list has the question", /POOL_SIZE/.test(await alice.locator(".ctx-pin").innerText()));
ok("the note field shows an empty placeholder", (await alice.locator(".card input").getAttribute("placeholder")) === "Note (optional)" && (await alice.locator(".card input").inputValue()) === "");
await shot(alice, "ui-02-approver-view.png");
await alice.click(".btn.approve");
await alice.waitForSelector(".card.approved", { timeout: 10000 });
ok("card turns approved with the approver's name", /Alice/.test(await alice.locator(".verdict").innerText()));
await alice.waitForFunction(() => /Approved\. Applied/.test(document.querySelector(".timeline")?.innerText ?? ""), null, { timeout: 15000 });
ok("the agent continues after the verdict", true);
// the operator's open page updated by itself (SSE, no reload)
await bob.waitForSelector(".timeline .card.approved", { timeout: 10000 });
ok("the other person's page updated live without reloading", true);
ok("nothing needs attention any more", /Nothing needs you|caught up/.test(await bob.locator(".ctx-pin").innerText()));
await shot(bob, "ui-03-after-approval.png");

// --- Private chat with an image --------------------------------------------------------------------------
await bob.click(".side .item:has-text('Ops') >> nth=-1");
await bob.waitForSelector(".header h2:has-text('🔒')", { timeout: 10000 });
ok("clicking an agent opens a private chat", true);
await bob.locator("input[type=file]").setInputFiles({ name: "square.png", mimeType: "image/png", buffer: png(40, 40, [200, 30, 30]) });
await bob.waitForSelector(".previews .prev img", { timeout: 10000 });
ok("an attached image shows a preview", true);
await bob.fill("textarea", "what is in this picture?");
await bob.click(".send");
await bob.waitForSelector(".timeline .atts img.att", { timeout: 10000 });
ok("the sent image is shown in the thread", await bob.locator(".timeline .atts img.att").evaluate((i) => i.complete && i.naturalWidth === 40));
await bob.waitForFunction(() => /scripted demo/.test(document.querySelector(".timeline")?.innerText ?? ""), null, { timeout: 15000 });
await shot(bob, "ui-04-private-chat-image.png");

// --- Privacy: Alice must not see Bob's private chat or image ----------------------------------------------
await alice.reload(); await alice.waitForSelector(".shell");
ok("another person's private chat is not in the sidebar", (await alice.locator(".side .item:has-text('🔒')").count()) === 0);

// --- Viewer cannot post ----------------------------------------------------------------------------------
const carol = await open("carol");
await carol.goto(`${BASE}/#general`); await carol.reload(); await carol.waitForSelector(".timeline .notice");
ok("a viewer cannot type", await carol.locator("textarea").isDisabled());

// --- Phone width ----------------------------------------------------------------------------------------------
const phone = await open("alice", { width: 390, height: 800 });
await phone.goto(`${BASE}/#incidents`); await phone.reload(); await phone.waitForSelector(".timeline");
await shot(phone, "ui-05-phone-width.png");
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("phone width: no horizontal scrolling", overflow <= 0, `${overflow}px`);
ok("phone width: the thread and composer are visible", (await phone.locator(".timeline").isVisible()) && (await phone.locator("textarea").isVisible()));
ok("phone width: the channel list is hidden until asked", !(await onScreen(phone.locator(".side .item >> nth=0"))));
await phone.click(".navbtn");
await sleep(phone, 300);
ok("phone width: the menu button opens the channel list", await onScreen(phone.locator(".side .item >> nth=0")));
await shot(phone, "ui-06-phone-menu.png");
await phone.click(".side .item:has-text('general')");
await sleep(phone, 300);
ok("phone width: choosing a channel closes the list", !(await onScreen(phone.locator(".side .item >> nth=0"))));
ok("initials skip punctuation", /^[A-Z]{1,2}$/.test((await alice.locator(".me .avatar").innerText()).trim()));

await browser.close();
console.log(`\n${checks.filter((c) => c[0]).length}/${checks.length} checks passed, ${problems.length} problem(s)`);
for (const p of problems) console.log(" -", p);
process.exit(problems.length ? 1 : 0);
