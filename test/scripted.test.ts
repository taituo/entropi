import { test } from "node:test";
import assert from "node:assert/strict";
import { testCore } from "./helpers.ts";
import { seedRealm } from "../src/seed.ts";
import { demoRealm } from "../src/demo/realm.ts";
import { ScriptedAgents } from "../src/adapters/demo/scripted.ts";

const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

test("scripted loop: message -> agent work -> approval card -> verdict -> follow-up and work done", async () => {
	const { core } = testCore();
	seedRealm(core, demoRealm("main"));
	core.addActor("main", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] }, "system");
	const agents = new ScriptedAgents(core, { stepMs: 1 });
	const live: string[] = [];
	agents.live = (m) => live.push(m.text);

	const ask = core.postMessage("main", "incidents", "human:anna", { text: "@ops checkout-api kaatuu, korjaa" }).message;
	await agents.dispatch({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", text: ask.text, from: "human:anna", messageId: ask.id });
	await agents.dispatch({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", text: ask.text, from: "human:anna", messageId: ask.id }); // replay: no second answer

	const msgs = () => core.listMessages("main", "incidents", "human:anna");
	assert.equal(msgs().filter((m) => m.authorId === "agent:ops" && m.kind === "agent").length, 1);
	const card = msgs().find((m) => m.kind === "decision")!;
	assert.equal(card.meta.status, "open");
	assert.equal(core.focus("main", "human:anna").needsYou.length, 1);
	assert.ok(live.length >= 3, "streaming updates were pushed live, not logged");

	core.decide("main", String(card.meta.decisionId), "human:anna", "approve");
	await until(() => msgs().some((m) => /POOL_SIZE=4/.test(m.text) && m.authorId === "agent:ops" && /Approved/.test(m.text)));
	await until(() => core.getWork("main", "fix-" + ask.id)?.state === "done");
	assert.equal(core.getPresence("main", "agent:ops")?.state, "idle");
});

test("a rejected fix leaves the work blocked and raises attention", async () => {
	const { core } = testCore();
	seedRealm(core, demoRealm("main"));
	core.addActor("main", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] }, "system");
	const agents = new ScriptedAgents(core, { stepMs: 1 });
	const ask = core.postMessage("main", "incidents", "human:anna", { text: "@ops fix checkout" }).message;
	await agents.dispatch({ realmId: "main", spaceId: "incidents", agentId: "agent:ops", text: ask.text, from: "human:anna", messageId: ask.id });
	const card = core.listMessages("main", "incidents", "human:anna").find((m) => m.kind === "decision")!;
	core.decide("main", String(card.meta.decisionId), "human:anna", "reject", "not now");
	await until(() => core.getWork("main", "fix-" + ask.id)?.state === "blocked");
	assert.deepEqual(core.openAttention("main").map((a) => a.kind), ["blocked"]);
});
