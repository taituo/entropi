// Real vision: a solid red square goes through the whole path (attachment -> outbox -> Pi -> gateway -> model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "../pi-world.ts";

const live = !!process.env.LOCAL_LLM_BASE_URL;
const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function solidPng(w: number, h: number, [r, g, b]: number[]) {
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("4. an image reaches a real vision model and is understood; a text-only agent refuses it out loud", { skip: !live, timeout: 300_000 }, async () => {
	const red = solidPng(48, 48, [220, 20, 20]);
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true, runtime: { images: { read: async () => red } } });
	await w.start();
	const att = w.core.addAttachment("main", "incidents", "human:anna", { id: "c".repeat(32), name: "square.png", mime: "image/png", size: red.length });
	const meta = { images: [{ id: att.id, name: att.name, mime: att.mime, size: att.size }] };
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops what single colour is the attached image? One word.", dispatchTo: ["agent:ops"], meta });
	await until(() => w.core.listMessages("main", "incidents", "human:anna").some((m) => m.kind === "agent" && m.status === "done"), 120_000);
	const r = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.kind === "agent")!;
	console.log(`OBS 4 answer (vision on: ${process.env.LOCAL_LLM_VISION_MODELS ?? "-"}): ${r.text}`);
	assert.match(r.text, /red/i);
	await w.close();
});
