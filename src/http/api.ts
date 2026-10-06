import type { IncomingMessage, ServerResponse } from "node:http";
import type { Core } from "../core/core.ts";
import { handleOf, hasRole } from "../core/core.ts";
import { CoreError } from "../core/errors.ts";
import type { ActivityEvent, Actor, Id, Message, Space } from "../core/types.ts";
import type { AgentDispatcher } from "../core/ports.ts";
import type { Config } from "../config.ts";
import type { Hub } from "./sse.ts";
import type { User } from "./auth.ts";

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const STATUS: Record<CoreError["code"], number> = { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 };
export const statusOf = (e: any): number => e.status ?? (e instanceof CoreError ? STATUS[e.code] : 500);

export const json = (res: ServerResponse, code: number, body: unknown) =>
	res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

export async function readBody(req: IncomingMessage, max = 64_000): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > max) throw httpError(413, "body too large");
		chunks.push(c);
	}
	try {
		return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
	} catch {
		throw httpError(400, "invalid JSON");
	}
}

/** `human:<sub>` : the stable identity of a signed-in person. Names are snapshots, never identity. */
export const humanId = (sub: string): Id => `human:${sub}`;

/** First sign-in joins the default realm; later sign-ins refresh the name and roles the identity provider vouches for. */
export function ensureMember(core: Core, realmId: Id, user: User): Actor {
	const roles = user.roles.filter((r) => ["viewer", "operator", "approver", "admin"].includes(r));
	return core.addActor(realmId, { id: humanId(user.sub), kind: "human", name: user.name, roles: roles.length ? roles : ["viewer"] });
}

/** The wire shape of a space for the browser. */
export const spaceView = (s: Space) => ({
	id: s.id, name: s.name, topic: s.topic, kind: s.kind, status: s.status, owner: s.ownerId, agents: s.agentIds.map(handleOf), agentIds: s.agentIds,
});

/** Turn a committed core event into what the browser needs to update itself. */
export function eventView(core: Core, e: ActivityEvent): { type: string; payload: unknown } {
	if (e.type.startsWith("message.") && e.subjectKind === "message") {
		const message = core.getMessage(e.realmId, Number(e.subjectId));
		if (message) return { type: "message", payload: { message } };
	}
	if (e.type.startsWith("decision.")) {
		const decision = core.getDecision(e.realmId, e.subjectId);
		if (decision) return { type: "decision", payload: { decision } };
	}
	if (e.type === "presence.changed") return { type: "presence", payload: { presence: core.getPresence(e.realmId, e.subjectId) } };
	if (e.type.startsWith("space.")) {
		const space = core.getSpace(e.realmId, e.subjectId);
		if (space) return { type: "space", payload: { space: spaceView(space) } };
	}
	return { type: "event", payload: e };
}

export type Deps = { core: Core; hub: Hub; dispatcher?: AgentDispatcher; config: Pick<Config, "brand" | "defaultRealm"> };

/** All routes live under /api/realms/:realm; a person who is not a member gets 404, never 403. */
export async function api(req: IncomingMessage, res: ServerResponse, url: URL, user: User, d: Deps) {
	const { core } = d;
	const m = req.method ?? "GET";
	const path = url.pathname;
	if (m !== "GET" && req.headers["x-requested-with"] !== "entropi") throw httpError(403, "missing X-Requested-With");

	if (m === "GET" && path === "/api/me") {
		const realms = core.listRealms().filter((r) => core.getActor(r.id, humanId(user.sub)));
		return json(res, 200, { user: { sub: user.sub, id: humanId(user.sub), name: user.name }, brand: d.config.brand, defaultRealm: d.config.defaultRealm, realms });
	}

	const mm = /^\/api\/realms\/([a-z0-9][a-z0-9._-]*)(\/.*)?$/.exec(path);
	if (!mm) throw httpError(404, "no such endpoint");
	const realmId = mm[1], rest = mm[2] ?? "";
	const me = core.getActor(realmId, humanId(user.sub));
	if (!me) throw httpError(404, "no such realm");
	let r: RegExpExecArray | null;

	if (m === "GET" && rest === "") {
		return json(res, 200, {
			realm: core.getRealm(realmId), me,
			actors: core.listActors(realmId).filter((a) => a.kind !== "system"),
			presence: core.listActors(realmId).map((a) => core.getPresence(realmId, a.id)).filter(Boolean),
			spaces: core.listSpaces(realmId, me.id).map(spaceView),
		});
	}

	if (m === "GET" && rest === "/events") {
		const last = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
		d.hub.add(res, realmId, me.id, last);
		return;
	}

	if (m === "GET" && rest === "/focus") return json(res, 200, { focus: core.focus(realmId, me.id) });

	if (m === "GET" && (r = /^\/spaces\/([\w-]+)\/messages$/.exec(rest))) return json(res, 200, { messages: core.listMessages(realmId, r[1], me.id) });

	if (m === "POST" && (r = /^\/spaces\/([\w-]+)\/messages$/.exec(rest))) {
		const spaceId = r[1];
		const body = await readBody(req);
		const text = String(body.text ?? "").trim();
		if (!text || text.length > 4000) throw httpError(400, "message must be 1-4000 characters");
		const { message } = core.postMessage(realmId, spaceId, me.id, { text });
		const space = core.getSpace(realmId, spaceId)!;
		// A private chat answers every message; elsewhere only @mentions wake an agent.
		const { present, absent } = core.mentions(realmId, spaceId, text);
		const targets = space.kind === "dm" ? space.agentIds : present;
		for (const id of absent) {
			const names = space.agentIds.map(handleOf).join(", ");
			core.postMessage(realmId, spaceId, "system", { kind: "notice", text: `${handleOf(id)} is not in #${space.id}. Agents here: ${names}.` });
		}
		for (const agentId of targets) {
			d.dispatcher?.dispatch({ realmId, spaceId, agentId, text, from: me.id, messageId: message.id }).catch((e) => {
				core.postMessage(realmId, spaceId, "system", { kind: "notice", text: `Could not reach ${handleOf(agentId)}: ${e.message}` });
			});
		}
		return json(res, 200, { message, dispatchedTo: targets });
	}

	if (m === "POST" && rest === "/spaces") {
		const body = await readBody(req);
		const topic = String(body.topic ?? "").trim();
		if (!topic) throw httpError(400, "give a topic");
		if (!hasRole(me, "operator")) throw httpError(403, "operators only");
		const agents = core.listActors(realmId).filter((a) => a.kind === "agent").map((a) => a.id);
		const { space, created } = core.createSpace(realmId, { kind: "case", name: topic, topic, agentIds: agents }, me.id);
		if (created) core.postMessage(realmId, space.id, "system", { kind: "case", text: topic, meta: { source: "manual", openedBy: me.name } });
		return json(res, 200, { space: spaceView(space), created });
	}

	if (m === "POST" && rest === "/dms") {
		const body = await readBody(req);
		const agent = core.listActors(realmId).find((a) => a.kind === "agent" && handleOf(a.id) === String(body.agent ?? "").toLowerCase());
		if (!agent) throw httpError(400, "no such agent");
		if (!hasRole(me, "operator")) throw httpError(403, "operators only");
		const { space, created } = core.createSpace(realmId, { id: `dm-${handleOf(agent.id)}-${handleOf(me.id).slice(0, 12)}`, kind: "dm", name: agent.name, topic: `Private chat with ${agent.name}`, ownerId: me.id, agentIds: [agent.id] }, me.id);
		if (created) core.postMessage(realmId, space.id, "system", { kind: "notice", text: `Private chat with ${agent.name}. Only you can see it, and ${agent.name} answers every message (no @ needed). It cannot hand work to other agents.` });
		return json(res, 200, { space: spaceView(space), created });
	}

	if (m === "POST" && (r = /^\/spaces\/([\w-]+)\/(archive|reopen)$/.exec(rest))) {
		const space = core.setSpaceStatus(realmId, r[1], r[2] === "archive" ? "archived" : "open", me.id);
		return json(res, 200, { space: spaceView(space) });
	}

	if (m === "GET" && rest === "/decisions") {
		const open = core.openDecisions(realmId).filter((x) => {
			const sp = core.getWork(realmId, x.workId)?.spaceId;
			return !sp || core.canSee(realmId, me.id, sp);
		});
		return json(res, 200, { decisions: open });
	}

	if (m === "POST" && (r = /^\/decisions\/([\w-]+)\/decide$/.exec(rest))) {
		const body = await readBody(req);
		const dec = core.getDecision(realmId, r[1]);
		const spaceId = dec && core.getWork(realmId, dec.workId)?.spaceId;
		if (!dec || (spaceId && !core.canSee(realmId, me.id, spaceId))) throw httpError(404, "decision not found");
		const note = body.note ? String(body.note).slice(0, 300) : undefined;
		return json(res, 200, { decision: core.decide(realmId, dec.id, me.id, String(body.answer ?? ""), note) });
	}

	if (m === "GET" && rest === "/events/log") {
		if (!hasRole(me, "approver")) throw httpError(403, "approvers only");
		return json(res, 200, { events: core.events(realmId, Number(url.searchParams.get("after") ?? 0) || 0, 500).filter((e) => core.canSeeEvent(e, me.id)) });
	}

	throw httpError(404, "no such endpoint");
}
export type { Message };
