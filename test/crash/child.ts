// Runs one "process lifetime" of the system against files in a directory. Used by crash.test.ts, which kills it.
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { makeWorld } from "../pi-world.ts";
import { Binding } from "../../src/adapters/pi/binding.ts";

const [dir, action, arg] = process.argv.slice(2);
const storage = await openNodeSqliteStorage(join(dir, "pi.sqlite"));
const w = await makeWorld({ dbPath: join(dir, "core.sqlite"), storage });

if (action === "post") {
	w.core.postMessage("main", "incidents", "human:anna", { text: arg, dispatchTo: ["agent:ops"] });
}
await w.start();
if (action === "decide") {
	const d = w.core.openDecisions("main")[0];
	if (d) w.core.decide("main", d.id, "human:anna", arg || "approve", "ok");
}
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_MS ?? 2500)));

// What exists, as seen from both sides.
const summary: any = { agentMessages: [], decisions: 0, cards: 0, works: 0, outbox: [], piConversations: 0, piAssistantEntries: 0, submissionsPerRequest: {} };
const msgs = w.core.listMessages("main", "incidents", "human:anna", 500);
summary.agentMessages = msgs.filter((m) => m.kind === "agent").map((m) => ({ status: m.status, text: m.text }));
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
			summary.piAssistantEntries += ep.items.filter((e) => e.kind === "pi.assistant").length;
			ec = ep.next;
		} while (ec);
	}
	cursor = page.next;
} while (cursor);
console.log("SUMMARY " + JSON.stringify(summary));
process.exit(0);
