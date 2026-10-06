import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Core } from "../core/core.ts";
import type { AgentDispatcher } from "../core/ports.ts";
import type { Config } from "../config.ts";
import { api, ensureMember, eventView, json, statusOf } from "./api.ts";
import { createAuth } from "./auth.ts";
import { Hub } from "./sse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "..", "..", "public");
const NODE_MODULES = resolve(here, "..", "..", "node_modules");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon",
};
const VENDOR: Record<string, string> = { "/vendor/preact.js": join(NODE_MODULES, "htm/preact/standalone.module.js") };

async function serveStatic(res: import("node:http").ServerResponse, pathname: string) {
	const file = VENDOR[pathname] ?? resolve(PUBLIC, `.${normalize(pathname === "/" ? "/index.html" : pathname)}`);
	if (!VENDOR[pathname] && !file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
	try {
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(await readFile(file));
	} catch {
		json(res, 404, { error: "not found" });
	}
}

export type App = { server: Server; hub: Hub; close(): void };

/** The HTTP transport over the core. No listen here: the caller decides the port, tests use an ephemeral one. */
export function createApp(o: { core: Core; config: Config; dispatcher?: AgentDispatcher }): App {
	const { core, config } = o;
	const auth = createAuth(config);
	const hub = new Hub(core, (e) => eventView(core, e));
	const deps = { core, hub, dispatcher: o.dispatcher, config };

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", config.publicUrl);
		try {
			if (url.pathname === "/healthz") return json(res, 200, { ok: true });
			if (url.pathname === "/auth/login") return auth.login(req, res, url);
			if (url.pathname === "/auth/logout") return auth.logout(req, res);

			const user = auth.userFrom(req);
			if (url.pathname.startsWith("/api/")) {
				if (!user) return json(res, 401, { error: "not signed in" });
				// Joining is implicit and idempotent, so roles stay what the identity provider says.
				ensureMember(core, config.defaultRealm, user);
				return await api(req, res, url, user, deps);
			}
			if (!user && (url.pathname === "/" || url.pathname === "/index.html")) {
				res.writeHead(302, { location: "/auth/login" }).end();
				return;
			}
			return await serveStatic(res, url.pathname);
		} catch (e: any) {
			const status = statusOf(e);
			if (!res.headersSent) json(res, status, { error: e.message ?? "internal error" });
			else res.end();
			if (status === 500) console.error(e);
		}
	});
	return { server, hub, close: () => { hub.close(); server.close(); server.closeAllConnections?.(); } };
}
