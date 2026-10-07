// What a project that depends on Entropi does: its own realm, its own agent, its own source, its own server, assembled through createEntropi.
// Imports only the public entry; nothing here knows the demo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntropi, type EntropiSource, type SourceEvent } from "../src/index.ts";

const until = async (fn: () => boolean, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

/** A source with its own idea of the world: a counter that changes only through invoke, and announces what happens. */
class Counter implements EntropiSource {
	readonly id = "counter";
	value = 0;
	runs = 0;
	private seen = new Map<string, unknown>();
	private queue: SourceEvent[] = [];
	private wake?: () => void;
	emit(externalId: string, state: string) { this.queue.push({ workRef: { source: this.id, externalId }, state }); this.wake?.(); }
	async invoke(action: string, input: { by: number }, ctx: { idempotencyKey: string }) {
		if (this.seen.has(ctx.idempotencyKey)) return this.seen.get(ctx.idempotencyKey);
		this.runs++;
		const r = { value: (this.value += input.by) };
		this.seen.set(ctx.idempotencyKey, r);
		return r;
	}
	async *observe(signal: AbortSignal) {
		while (!signal.aborted) {
			while (this.queue.length) yield this.queue.shift()!;
			await new Promise<void>((r) => { this.wake = r; signal.addEventListener("abort", () => r(), { once: true }); });
		}
	}
}

test("another project builds its own server from parts: data-driven realm, own runtime, own source, HTTP; the demo cast is nowhere", async () => {
	const counter = new Counter();
	const unlinked: string[] = [];
	const e = await createEntropi({
		dataDir: mkdtempSync(join(tmpdir(), "entropi-consumer-")),
		realm: { id: "acme", name: "Acme", agents: [{ id: "agent:helper", name: "Helper", title: "Does favours", spaces: ["lobby"], mood: "calm" }], spaces: [{ id: "lobby", topic: "Say hi" }, { id: "quiet", welcome: false }] },
		config: { auth: { mode: "proxy", userHeader: "x-forwarded-user", defaultRoles: ["operator"] } },
		sources: [{ source: counter, onUnlinked: (ev) => { unlinked.push(ev.workRef.externalId); } }],
		dispatcher: ({ core }) => ({
			// the smallest possible runtime: speaks only through the core, idempotent per message
			async dispatch(o) {
				const r = core.postMessage(o.realmId, o.spaceId, o.agentId, { text: `echo: ${o.text}`, requestId: `reply:${o.messageId}:${o.agentId}` });
				void r;
			},
		}),
	});
	const port = await e.listen(0);
	const base = `http://127.0.0.1:${port}`;
	try {
		// the data became the realm: this agent, these spaces, no demo cast
		assert.deepEqual(e.core.listActors("acme").filter((a) => a.kind === "agent").map((a) => a.id), ["agent:helper"]);
		assert.deepEqual(e.core.getActor("acme", "agent:helper")!.profile, { title: "Does favours", mood: "calm" }, "everything but id, name and spaces is the profile");
		assert.deepEqual(e.core.listSpaces("acme", "system" as any).map((s) => s.id).sort(), ["lobby", "quiet"]);
		assert.equal(e.core.listMessages("acme", "quiet", "system" as any).length, 0, "welcome: false posts nothing");

		// HTTP works with the identity the proxy supplies, under /api/v1
		const call = (path: string, body?: object) => fetch(`${base}/api/v1${path}`, { method: body ? "POST" : "GET", headers: { "x-forwarded-user": "anna", "x-requested-with": "entropi", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		assert.equal((await fetch(`${base}/api/v1/me`)).status, 401);
		const realm: any = await (await call("/realms/acme")).json();
		assert.deepEqual(realm.spaces.map((s: any) => s.id).sort(), ["lobby", "quiet"]);
		assert.equal((await call("/realms/acme/spaces/lobby/messages", { text: "@helper hello" })).status, 200);
		await until(() => e.core.listMessages("acme", "lobby", "human:anna").some((m) => m.text.startsWith("echo: ") && m.text.includes("@helper hello")));

		// the source: an unlinked thing is reported to the owner's policy; a linked one is cached on its ref; the effect honours the key
		counter.emit("job/1", "running");
		await until(() => unlinked.includes("job/1"));
		e.core.createWork("acme", { id: "w1", kind: "task", title: "Job 1", state: "working" }, "system");
		e.core.linkRef("acme", "w1", { source: "counter", externalId: "job/1", state: "unknown" }, "system");
		counter.emit("job/1", "finished");
		await until(() => e.core.getRef("acme", "counter", "job/1")?.state === "finished");
		await counter.invoke("add", { by: 5 }, { idempotencyKey: "k" });
		await counter.invoke("add", { by: 5 }, { idempotencyKey: "k" });
		assert.deepEqual([counter.value, counter.runs], [5, 1]);
	} finally {
		await e.close();
		await e.close(); // idempotent
	}
});

test("createEntropi refuses ambiguous input and needs no environment", async () => {
	const base = { dataDir: mkdtempSync(join(tmpdir(), "entropi-consumer-")), realm: { id: "r", agents: [], spaces: [] } };
	await assert.rejects(createEntropi({ ...base, pi: { inference: { airgapped: true, perAgent: {} } }, dispatcher: () => ({ dispatch: async () => {} }) }), /either pi or dispatcher/);
	const a = { id: "x", agents: [], spaces: [] }, s = new Counter();
	await assert.rejects(createEntropi({ dataDir: mkdtempSync(join(tmpdir(), "entropi-consumer-")), realm: a, sources: [s, s] }), /share the id "counter"/);
	// no runtime at all is allowed: messages wait in the outbox for whoever drains it
	const e = await createEntropi({ ...base, dataDir: mkdtempSync(join(tmpdir(), "entropi-consumer-")) });
	assert.equal(e.runtime, undefined);
	await e.close();
});
