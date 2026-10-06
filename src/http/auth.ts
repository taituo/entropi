import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.ts";

/** Who is calling, as far as the core is concerned. Becomes an Actor (`human:<sub>`) in each realm they belong to. */
export type User = { sub: string; name: string; roles: string[] };

const DEV_USERS: Record<string, User> = {
	alice: { sub: "dev-alice", name: "Alice (approver)", roles: ["approver"] },
	bob: { sub: "dev-bob", name: "Bob (operator)", roles: ["operator"] },
	carol: { sub: "dev-carol", name: "Carol (viewer)", roles: ["viewer"] },
};
const SESSION_TTL_S = 8 * 3600;

const header = (req: IncomingMessage, name: string): string | undefined => {
	const v = req.headers[name.toLowerCase()];
	const s = (Array.isArray(v) ? v[0] : v)?.trim();
	return s ? s : undefined;
};

/**
 * Two ways to know who is calling, nothing else (see docs/steering.md):
 *  - "dev":   a local picker that sets a signed cookie. For laptops and tests only.
 *  - "proxy": trust the identity a reverse proxy in front of us put in a header. Only when explicitly switched on.
 */
export function createAuth(cfg: Pick<Config, "sessionSecret" | "cookieSecure" | "auth">) {
	const a = cfg.auth;
	const mac = (data: string) => createHmac("sha256", cfg.sessionSecret).update(data).digest("base64url");
	const seal = (payload: object) => {
		const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
		return `${body}.${mac(body)}`;
	};
	function unseal(value: string | undefined): (User & { exp: number }) | undefined {
		const [body, sig] = (value ?? "").split(".");
		if (!body || !sig) return undefined;
		const expected = Buffer.from(mac(body)), given = Buffer.from(sig);
		if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
		try {
			const p = JSON.parse(Buffer.from(body, "base64url").toString());
			return p.exp && p.exp < Date.now() / 1000 ? undefined : p;
		} catch {
			return undefined;
		}
	}
	const cookie = (req: IncomingMessage, name: string) => {
		for (const part of (req.headers.cookie ?? "").split(";")) {
			const i = part.indexOf("=");
			if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
		}
		return undefined;
	};
	const setCookie = (res: ServerResponse, value: string, maxAge: number) =>
		res.setHeader("set-cookie", [`session=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(cfg.cookieSecure ? ["Secure"] : [])].join("; "));

	return {
		userFrom(req: IncomingMessage): User | undefined {
			if (a.mode === "proxy") {
				const sub = header(req, a.userHeader);
				if (!sub) return undefined;
				const raw = a.rolesHeader ? header(req, a.rolesHeader) : undefined;
				const roles = raw ? raw.split(",").map((r) => r.trim()).filter(Boolean) : a.defaultRoles;
				return { sub, name: (a.nameHeader && header(req, a.nameHeader)) || sub, roles };
			}
			const s = unseal(cookie(req, "session"));
			return s && { sub: s.sub, name: s.name, roles: s.roles };
		},

		login(_req: IncomingMessage, res: ServerResponse, url: URL) {
			if (a.mode === "proxy") return void res.writeHead(302, { location: "/" }).end(); // the proxy already signed you in
			const as = url.searchParams.get("as");
			if (as && DEV_USERS[as]) {
				setCookie(res, seal({ ...DEV_USERS[as], exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }), SESSION_TTL_S);
				res.writeHead(302, { location: "/" }).end();
				return;
			}
			res.writeHead(200, { "content-type": "text/html" }).end(`<h3>Dev login (AUTH_MODE=dev)</h3>${Object.keys(DEV_USERS).map((k) => `<p><a href="/auth/login?as=${k}">${k}</a></p>`).join("")}`);
		},

		logout(_req: IncomingMessage, res: ServerResponse) {
			if (a.mode === "proxy") return void res.writeHead(302, { location: a.logoutUrl || "/" }).end();
			setCookie(res, "", 0);
			res.writeHead(302, { location: "/auth/login" }).end();
		},
	};
}
export type Auth = ReturnType<typeof createAuth>;
