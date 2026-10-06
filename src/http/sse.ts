import type { ServerResponse } from "node:http";
import type { Core } from "../core/core.ts";
import type { ActivityEvent, Id } from "../core/types.ts";

type Client = { res: ServerResponse; realmId: Id; actorId: Id };
export type Live = { realmId: Id; spaceId?: Id; type: string; [k: string]: unknown };

/**
 * Server-sent events, one stream per signed-in person. Two sources:
 *  - committed core events (with ids, so `Last-Event-ID` resumes exactly where the client stopped)
 *  - live, ephemeral updates (an agent's message while it types), which are never logged and never replayed
 * Everything is filtered per viewer by the core's own visibility rules, server-side.
 */
export class Hub {
	private clients = new Set<Client>();
	private core: Core;
	private view: (e: ActivityEvent) => { type: string; payload: unknown };
	private off: () => void;
	private timer: NodeJS.Timeout;

	/** `view` turns a core event into what the browser needs (a fresh message, a decision...). */
	constructor(core: Core, view: Hub["view"]) {
		this.core = core;
		this.view = view;
		this.off = core.subscribe((e) => this.fanout(e));
		this.timer = setInterval(() => { for (const c of this.clients) c.res.write(": ping\n\n"); }, 20_000);
		this.timer.unref();
	}

	get size() {
		return this.clients.size;
	}

	/**
	 * Replay and registration happen in one synchronous step, and the core publishes only after a commit finished, so
	 * nothing can fall between "what the client missed" and "what arrives live".
	 */
	add(res: ServerResponse, realmId: Id, actorId: Id, lastEventId: number) {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		const c: Client = { res, realmId, actorId };
		res.write(`event: hello\ndata: {}\n\n`);
		if (lastEventId > 0) for (const e of this.core.events(realmId, lastEventId, 5000)) this.send(c, e);
		this.clients.add(c);
		res.on("close", () => this.clients.delete(c));
	}

	private send(c: Client, e: ActivityEvent) {
		if (e.realmId !== c.realmId || !this.core.canSeeEvent(e, c.actorId)) return;
		const v = this.view(e);
		c.res.write(`id: ${e.seq}\nevent: ${v.type}\ndata: ${JSON.stringify(v.payload)}\n\n`);
	}

	private fanout(e: ActivityEvent) {
		for (const c of this.clients) this.send(c, e);
	}

	/** Ephemeral push (no id, not replayed), visible only to people who can see the space. */
	live(ev: Live) {
		for (const c of this.clients) {
			if (c.realmId !== ev.realmId) continue;
			if (ev.spaceId && !this.core.canSee(c.realmId, c.actorId, ev.spaceId)) continue;
			c.res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
		}
	}

	close() {
		this.off();
		clearInterval(this.timer);
		for (const c of this.clients) c.res.end();
		this.clients.clear();
	}
}
