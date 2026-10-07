// A stand-in OpenAI-compatible gateway that records what the runtime sends: session ids, image payloads, failures.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Core } from "../src/core/core.ts";
import { openDb } from "../src/core/db.ts";
import { PiRuntime } from "../src/adapters/pi/runtime.ts";
import { buildInference, inferenceFromEnv } from "../src/adapters/pi/inference.ts";
import { DispatchPump } from "../src/runtime/pump.ts";
import { seedRealm } from "../src/seed.ts";
import { demoRealm } from "../src/demo/realm.ts";
import { until } from "./pi-world.ts";

type Seen = { headers: Record<string, string | string[] | undefined>; body: any };
const seen: Seen[] = [];
let mode: "ok" | "quota" | "flaky" = "ok";
let flakyCalls = 0;
const gw = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		seen.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
		if (mode === "flaky" && flakyCalls++ === 0) return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "upstream overloaded, try again" } }));
		if (mode === "quota") return void res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "monthly quota exceeded for this plan", type: "insufficient_quota" } }));
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: any, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: seen.at(-1)!.body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: "seen" }));
		res.write(chunk({}, "stop"));
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((r) => gw.listen(0, r));
after(() => gw.close());
const base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1`;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function world(env: Record<string, string>) {
	const core = new Core(openDb(":memory:"));
	seedRealm(core, demoRealm("main"));
	core.addActor("main", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] }, "system");
	const inference = buildInference(inferenceFromEnv({ LOCAL_LLM_BASE_URL: base, LOCAL_LLM_MODEL: "text-model", LOCAL_LLM_API_KEY: "k", AIRGAPPED: "true", ...env } as any));
	const runtime = new PiRuntime({ core, storage: new MemoryStorage(), inference, images: { read: async () => PNG } });
	await runtime.start();
	const pump = new DispatchPump(core, runtime);
	pump.start();
	return { core, runtime, close: async () => { pump.stop(); await runtime.close(); } };
}
const say = (core: Core, text: string, space = "incidents", meta: any = {}, to = "agent:ops") => core.postMessage("main", space, "human:anna", { text, dispatchTo: [to], meta }).message;
const reply = (core: Core, space = "incidents", who = "agent:ops") => core.listMessages("main", space, "human:anna").filter((m) => m.kind === "agent" && m.authorId === who);
const sessionOf = (s: Seen) => String(s.headers["x-session-id"] ?? "");

test("every conversation sends a stable x-session-id; different conversations send different ones", async () => {
	seen.length = 0; mode = "ok";
	const w = await world({});
	say(w.core, "@ops first"); await until(() => reply(w.core).some((m) => m.status === "done"));
	say(w.core, "@ops second"); await until(() => reply(w.core).filter((m) => m.status === "done").length === 2);
	say(w.core, "@ops elsewhere", "general"); await until(() => reply(w.core, "general").some((m) => m.status === "done"));
	const ids = seen.map(sessionOf);
	assert.ok(ids.every(Boolean), "the header is always present");
	assert.equal(ids[0], ids[1], "same conversation, same id for the whole conversation");
	assert.notEqual(ids[0], ids[2], "another conversation gets another id");
	await w.close();
});

test("a vision model receives the image as a data: URI; nothing is fetched by URL", async () => {
	seen.length = 0; mode = "ok";
	const w = await world({ LOCAL_LLM_VISION_MODELS: "text-model" });
	const att = w.core.addAttachment("main", "incidents", "human:anna", { id: "a".repeat(32), name: "dot.png", mime: "image/png", size: PNG.length });
	say(w.core, "@ops what is in the picture?", "incidents", { images: [{ id: att.id, name: att.name, mime: att.mime, size: att.size }] });
	await until(() => reply(w.core).some((m) => m.status === "done"));
	const content = seen.at(-1)!.body.messages.at(-1).content;
	const img = content.find((b: any) => b.type === "image_url");
	assert.match(img.image_url.url, /^data:image\/png;base64,/);
	assert.ok(!w.core.listMessages("main", "incidents", "human:anna").some((m) => /NOT sent/.test(m.text)), "no refusal for a vision model");
	await w.close();
});

test("a text-only model gets no pixels, and everybody is told", async () => {
	seen.length = 0; mode = "ok";
	const w = await world({});
	const att = w.core.addAttachment("main", "incidents", "human:anna", { id: "b".repeat(32), name: "dot.png", mime: "image/png", size: PNG.length });
	say(w.core, "@ops look", "incidents", { images: [{ id: att.id, name: att.name, mime: att.mime, size: att.size }] });
	await until(() => reply(w.core).some((m) => m.status === "done"));
	assert.ok(!JSON.stringify(seen.at(-1)!.body).includes("image_url"));
	assert.match(JSON.stringify(seen.at(-1)!.body.messages.at(-1).content), /cannot see them/);
	assert.ok(w.core.listMessages("main", "incidents", "human:anna").some((m) => m.kind === "notice" && /does not support images/.test(m.text)));
	await w.close();
});

test("per agent models: each agent calls the model it was given", async () => {
	seen.length = 0; mode = "ok";
	const w = await world({ AGENT_INSIGHT_MODEL: "local/cheap-model", OPTCHAT_MODEL: "local/cheap-model" });
	say(w.core, "@ops hi"); await until(() => reply(w.core).some((m) => m.status === "done"));
	say(w.core, "@insight hi", "insights", {}, "agent:insight"); await until(() => reply(w.core, "insights", "agent:insight").some((m) => m.status === "done"));
	assert.deepEqual(seen.map((s) => s.body.model), ["text-model", "cheap-model"]);
	await w.close();
});

test("a full quota is reported clearly to the people, nothing is dropped, and it works again later", async () => {
	seen.length = 0; mode = "quota";
	const w = await world({});
	say(w.core, "@ops hello");
	await until(() => reply(w.core).some((m) => m.status === "done"), 30_000);
	const r = reply(w.core)[0];
	assert.match(r.text, /quota or rate limit is used up/);
	assert.match(r.text, /Nothing was lost/);
	mode = "ok";
	say(w.core, "@ops hello again");
	await until(() => reply(w.core).filter((m) => m.status === "done").length === 2);
	assert.equal(reply(w.core)[1].text, "seen");
	await w.close();
});

test("the empty `error` assistant entry: a failed first attempt that Pi retries. It is recorded with its cause, and the answer is unaffected", async () => {
	seen.length = 0; mode = "flaky"; flakyCalls = 0;
	const w = await world({});
	say(w.core, "@ops hello");
	await until(() => reply(w.core).some((m) => m.status === "done"), 60_000);
	const r = reply(w.core)[0];
	assert.equal(r.text, "seen", "the retry answered");
	const f = (r.meta.failures as any[]) ?? [];
	assert.equal(f.length, 1, "exactly one failed attempt is on the record");
	assert.equal(f[0].stopReason, "error");
	assert.match(f[0].error, /overloaded|500/i, "with the gateway's own words");
	assert.equal(seen.length, 2, "two requests: the failed one and the retry");
	const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
	const conv = (await w.runtime.storage.scanConversations({}, 5, undefined, ctx)).items[0];
	const entries = (await w.runtime.storage.scanEntries({ conversationId: conv.id }, 20, undefined, ctx)).items.filter((e) => e.kind === "pi.assistant");
	const err = entries.find((e: any) => e.model?.[0]?.stopReason === "error") as any;
	assert.ok(err, "Pi did write an assistant entry with stopReason error");
	assert.deepEqual(err.model[0].content, [], "and it is empty, exactly as seen once in the live crash test");
	mode = "ok";
	await w.close();
});
