// Runs INSIDE a sandbox. It is Pi's own NodeExecutionEnv (mounted read-only at PI_ENV_DIR) behind a tiny authenticated
// RPC, so the agent's read/write/edit/bash tools get exactly the behaviour Pi gives them anywhere else: output windows,
// spill files, timeouts, line scanning, binary readers. This file only moves calls and results across the boundary.
// The container (non-root, read-only root, no capabilities, resource limits, no network) is the security boundary, not
// this file: there is no path jail here because everything the env can touch is already inside the sandbox.
//
// Listens on a unix socket (LISTEN_SOCKET: a container with NO network, airgapped) or on TCP (PORT: a pod).
import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import fs from "node:fs/promises";

const TOKEN = process.env.RUNNER_TOKEN ?? "";
delete process.env.RUNNER_TOKEN; // children must not inherit it
const ROOT = process.env.WORK_DIR ?? "/work";
const PORT = Number(process.env.PORT ?? 8099);
const SOCKET = process.env.LISTEN_SOCKET;
const { NodeExecutionEnv } = await import(`${process.env.PI_ENV_DIR ?? "/opt/pi-env"}/node.js`);
const env = new NodeExecutionEnv({ cwd: ROOT });

const METHODS = new Set(["absolutePath", "joinPath", "canonicalPath", "exists", "fileInfo", "readTextFile", "readBinaryFile", "writeFile", "appendFile", "createDir", "listDir", "remove", "renameFile", "openBinaryReader"]);
const READER = new Set(["info", "read", "scanLines", "close"]);
const handles = new Map();

// Values that JSON cannot carry: bytes, and the env's error classes.
const enc = (v) => v instanceof Uint8Array ? { $u8: Buffer.from(v).toString("base64") }
	: v instanceof Error ? { $err: v.constructor.name, code: v.code, message: v.message, path: v.path, spillPath: v.spillPath }
	: Array.isArray(v) ? v.map(enc) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;
const dec = (v) => v && v.$u8 !== undefined ? new Uint8Array(Buffer.from(v.$u8, "base64")) : Array.isArray(v) ? v.map(dec) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)])) : v;

const send = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
const authed = (req) => {
	const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, "")), want = Buffer.from(TOKEN);
	return TOKEN.length >= 16 && given.length === want.length && timingSafeEqual(given, want);
};
async function body(req) {
	const chunks = []; let n = 0;
	for await (const c of req) { n += c.length; if (n > 8 * 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(c); }
	return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

http.createServer(async (req, res) => {
	try {
		if (req.url === "/health") return send(res, 200, { ok: true });
		if (!authed(req)) return send(res, 401, { error: "unauthorized" });
		const ac = new AbortController();
		res.on("close", () => { if (!res.writableEnded) ac.abort(); }); // the caller went away: stop what it started
		const context = { abortSignal: ac.signal };
		const { m, a = [], h } = await body(req);
		if (req.method !== "POST") return send(res, 405, { error: "POST only" });

		if (req.url === "/exec") { // streamed: output chunks as they happen, then the result
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			const [command, options = {}] = dec(a);
			const r = await env.exec(command, { ...options, onOutput: (text, _c, info) => res.write(JSON.stringify({ o: text, i: info }) + "\n") }, context);
			return void res.end(JSON.stringify({ r: enc(r) }) + "\n");
		}
		if (h) { // a method of an open reader
			const reader = handles.get(h);
			if (!reader || !READER.has(m)) return send(res, 404, { error: "no such handle or method" });
			const r = await reader[m](...dec(a), context);
			if (m === "close") handles.delete(h);
			return send(res, 200, { r: enc(r) });
		}
		if (!METHODS.has(m)) return send(res, 404, { error: `not supported: ${m}` });
		const r = await env[m](...dec(a), context);
		if (m === "openBinaryReader" && r.ok) { const id = randomUUID(); handles.set(id, r.value); return send(res, 200, { r: { ok: true, value: { $handle: id } } }); }
		send(res, 200, { r: enc(r) });
	} catch (e) {
		if (!res.headersSent) send(res, e.status ?? 500, { error: String(e.message ?? e) });
		else res.end();
	}
}).listen(...(SOCKET ? [SOCKET] : [PORT, "0.0.0.0"]), async () => {
	if (SOCKET) await fs.chmod(SOCKET, 0o666); // access is the token; the directory is what the host controls
	console.log(`runner on ${SOCKET ?? ":" + PORT}, root ${ROOT}`);
});
