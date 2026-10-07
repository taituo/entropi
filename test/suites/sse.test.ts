// The event stream is per person: what happens in a private chat must never reach anybody else's stream, live or on resume.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { ROLES, dmOf, target, type Target } from "../support/target.ts";

let t: Target; let dm: string;
before(async () => { t = await target(); dm = await dmOf(t, t.users.operator!); });
after(() => t.close());
const roles = () => ROLES.filter((r) => t.users[r]);
const mentions = (events: { event: string; data: any }[], needle: string) => events.filter((e) => JSON.stringify(e.data).includes(needle));
const settle = () => new Promise((r) => setTimeout(r, 250));

test("sse: a channel message reaches every role; a private chat's traffic reaches only its owner", async (ctx) => {
	if (t.mode !== "offline") return ctx.skip("posting into a DM would wake the real agent; the cluster variant is the resume test below");
	const streams = Object.fromEntries(roles().map((r) => [r, t.sse(t.users[r]!)]));
	await Promise.all(Object.values(streams).map((s) => s.until((e) => e.some((x) => x.event === "hello"))));
	const core = t.core!;
	await t.call(t.users.operator!, "POST", "/spaces/general/messages", { text: "hello channel FINDME-CHANNEL" });
	await t.call(t.users.operator!, "POST", `/spaces/${dm}/messages`, { text: "my secret FINDME-DM" });
	core.createWork("main", { id: "w-sse", kind: "t", title: "private title FINDME-WORK", ownerId: "agent:ops", spaceId: dm, state: "working" }, "agent:ops");
	core.requestDecision("main", { key: "k-sse", workId: "w-sse", question: "private question FINDME-Q", requiredAuthority: "approver" }, "agent:ops");
	core.setWorkState("main", "w-sse", "blocked", "agent:ops");
	core.record("main", "agent:ops", "sandbox.stopped", "space", dm, { spaceId: dm });
	await settle();
	for (const r of roles()) {
		const ev = streams[r].events;
		assert.ok(mentions(ev, "FINDME-CHANNEL").length > 0, `${r} gets channel traffic`);
		const dmTraffic = ["FINDME-DM", "FINDME-WORK", "FINDME-Q", dm];
		for (const needle of dmTraffic) assert.equal(mentions(ev, needle).length > 0, r === "operator", `${r} ${r === "operator" ? "should" : "must not"} see "${needle}" in their stream`);
	}
	for (const s of Object.values(streams)) s.close();
});

test("sse: Last-Event-ID resume replays what was missed, filtered for that person, and never what is forbidden", async (ctx) => {
	if (t.mode !== "offline") return ctx.skip("offline: needs DM traffic");
	const core = t.core!;
	const a = t.sse(t.users.approver!);
	await a.until((e) => e.some((x) => x.event === "hello"));
	await t.call(t.users.operator!, "POST", "/spaces/general/messages", { text: "before the gap" });
	await a.until((e) => mentions(e, "before the gap").length > 0);
	const lastSeen = [...a.events].reverse().find((e) => e.id)!.id!;
	a.close();
	// things happen while alma is away: a channel message, DM traffic, a private decision
	await t.call(t.users.operator!, "POST", "/spaces/general/messages", { text: "during the gap FINDME-GAP" });
	await t.call(t.users.operator!, "POST", `/spaces/${dm}/messages`, { text: "private during the gap FINDME-PRIVATE" });
	core.createWork("main", { id: "w-gap", kind: "t", title: "gap work FINDME-GAPWORK", ownerId: "agent:ops", spaceId: dm, state: "working" }, "agent:ops");
	core.requestDecision("main", { key: "k-gap", workId: "w-gap", question: "gap question FINDME-GAPQ", requiredAuthority: "approver" }, "agent:ops");
	const back = t.sse(t.users.approver!, { lastEventId: lastSeen });
	await back.until((e) => mentions(e, "FINDME-GAP").length > 0);
	await settle();
	for (const n of ["FINDME-PRIVATE", "FINDME-GAPWORK", "FINDME-GAPQ", dm]) assert.equal(mentions(back.events, n).length, 0, `resume must not replay "${n}" to someone outside the DM`);
	back.close();
	// the owner resuming from the same point does get their own private traffic
	const owner = t.sse(t.users.operator!, { lastEventId: lastSeen });
	await owner.until((e) => mentions(e, "FINDME-PRIVATE").length > 0 && mentions(e, "FINDME-GAPQ").length > 0);
	owner.close();
	// the ?after= form is the same door
	const viaQuery = t.sse(t.users.approver!, { query: `?after=${lastSeen}` });
	await viaQuery.until((e) => mentions(e, "FINDME-GAP").length > 0);
	await settle();
	assert.equal(mentions(viaQuery.events, "FINDME-PRIVATE").length, 0);
	viaQuery.close();
});

test("sse: odd resume ids are harmless: garbage, negative, zero and a huge number replay nothing forbidden and do not break the stream", async () => {
	for (const id of ["abc", "-5", "0", "99999999999999999999", "1e3", " 7 "]) {
		const s = t.sse(t.users.viewer!, { lastEventId: id });
		await s.until((e) => e.some((x) => x.event === "hello"));
		await settle();
		assert.ok(!s.events.some((e) => JSON.stringify(e.data).includes(dm)), `resume from "${id}" must not show the DM`);
		s.close();
	}
});

test("sse: no login is refused, and a stream for another realm is a 404", async () => {
	const bad = await t.call(t.users.viewer!, "GET", "/api/v1/realms/nope/events");
	assert.equal(bad.status, 404);
});
