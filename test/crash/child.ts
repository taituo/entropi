// Runs one "process lifetime" of the system against files in a directory. Used by crash.test.ts, which kills it.
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { makeWorld } from "../pi-world.ts";
import { Binding } from "../../src/adapters/pi/binding.ts";

const [dir, action, arg] = process.argv.slice(2);
const storage = await openNodeSqliteStorage(join(dir, "pi.sqlite"));
const w = await makeWorld({ dbPath: join(dir, "core.sqlite"), storage, real: process.env.LIVE === "1", sandboxDir: process.env.SBX_DIR, runtime: process.env.KEEP ? { keepRecentTokens: Number(process.env.KEEP) } : undefined });

if (action === "post") {
	for (const text of arg.split("|")) w.core.postMessage("main", process.env.SPACE ?? "incidents", "human:anna", { text, dispatchTo: [process.env.AGENT ?? "agent:ops"] });
}
await w.start();
if (action === "compact") {
	await new Promise((r) => setTimeout(r, 300));
	await w.runtime.compact({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", by: "human:anna" });
}
if (action === "decide") {
	const d = w.core.openDecisions("main")[0];
	if (d) w.core.decide("main", d.id, "human:anna", arg || "approve", "ok");
}
// Wait until the system is quiet (nothing being written, nothing waiting to be delivered), or - when it is blocked on a
// person - until that state has been stable for a while. Bounded by SETTLE_MS.
{
	const t0 = Date.now();
	let stableSince = 0, last = "";
	while (Date.now() - t0 < Number(process.env.SETTLE_MS ?? 6000)) {
		await new Promise((r) => setTimeout(r, 200));
		const working = w.core.trusted.workingMessages().length, pending = w.core.trusted.pendingOutbox().length, open = w.core.openDecisions("main").length;
		const state = `${working}/${pending}/${open}`;
		if (state !== last) { last = state; stableSince = Date.now(); }
		const quiet = working === 0 && pending === 0;
		const blocked = open > 0 && pending === 0;
		if (Date.now() - t0 > 600 && Date.now() - stableSince > (quiet ? 600 : blocked ? 3000 : 1e9)) break;
	}
}

// What exists, as seen from both sides.
const summary: any = { agentMessages: [], decisions: 0, cards: 0, works: 0, outbox: [], piConversations: 0, piAssistantEntries: 0, submissionsPerRequest: {} };
const msgs = w.core.listMessages("main", "incidents", "human:anna", 500);
summary.agentMessages = msgs.filter((m) => m.kind === "agent").map((m) => ({ status: m.status, text: m.text }));
summary.agentAuthors = msgs.filter((m) => m.kind === "agent").map((m) => m.authorId);
summary.compactions = 0;
summary.cards = msgs.filter((m) => m.kind === "decision").length;
summary.decisions = (w.core.db.prepare("SELECT COUNT(*) n FROM decisions").get() as any).n;
summary.works = (w.core.db.prepare("SELECT COUNT(*) n FROM work").get() as any).n;
summary.outbox = w.core.db.prepare("SELECT status FROM outbox").all().map((r: any) => r.status);
let cursor: any;
do {
	const page = await storage.scanConversations({}, 100, cursor, ctx);
	for (const c of page.items) {
		const b = await w.runtime.harness.snapshot(Binding, c.id, ctx);
		if (b?.realm) summary.piConversations++;
		let ec: any;
		do {
			const ep = await storage.scanEntries({ conversationId: c.id }, 100, ec, ctx);
			summary.compactions += ep.items.filter((e) => e.kind === "pi.compaction").length;
			summary.piAssistantEntries += ep.items.filter((e) => e.kind === "pi.assistant" && !["aborted", "error"].includes((e as any).model?.[0]?.stopReason)).length;
			summary.piFailedAttempts = (summary.piFailedAttempts ?? 0) + ep.items.filter((e) => e.kind === "pi.assistant" && ["aborted", "error"].includes((e as any).model?.[0]?.stopReason)).length;
			ec = ep.next;
		} while (ec);
	}
	cursor = page.next;
} while (cursor);
console.log("SUMMARY " + JSON.stringify(summary));
process.exit(0);
