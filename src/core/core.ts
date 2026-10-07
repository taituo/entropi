import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { conflict, forbidden, invalid, notFound } from "./errors.ts";
import type {
	Actor, ActorKind, Attachment, AttentionItem, AttentionKind, DecisionRequest, ExternalRef, Focus, Id, Message, MessageKind, Presence, PresenceState,
	OutboxItem, Realm, RealmKind, RealmPolicy, Space, SpaceKind, WorkItem, WorkState, ActivityEvent,
} from "./types.ts";

export const SYSTEM: Id = "system";
const WORK_STATES: WorkState[] = ["queued", "working", "waiting", "blocked", "failed", "done", "cancelled"];
const TERMINAL: WorkState[] = ["done", "cancelled"];
const DEFAULT_POLICY: RealmPolicy = { separationOfDuties: true, maxDelegationDepth: 3, delegationsPer10Min: 8, maxDelegationsPerRun: 2 };
/** Built-in roles are a ladder (an approver is also an operator); any other role must match exactly. */
const RANK: Record<string, number> = { viewer: 0, operator: 1, approver: 2, admin: 3 };
const URGENCIES = ["low", "normal", "high"];
const SPACE_KINDS = ["standing", "case", "dm"];
export const hasRole = (a: Pick<Actor, "roles">, role: string): boolean =>
	Object.hasOwn(RANK, role) ? a.roles.some((r) => Object.hasOwn(RANK, r) && RANK[r] >= RANK[role]) : a.roles.includes(role) || a.roles.includes("admin");

type Row = Record<string, any>;
export type Listener = (e: ActivityEvent) => void;

export interface Trusted {
	pendingOutbox(limit?: number): OutboxItem[];
	markOutbox(id: number, status: "sent" | "failed", error?: string): void;
	bumpOutbox(id: number, error: string): number;
	cancelOutboxFromRun(runId: string, reason: string): number;
	workingMessages(): Message[];
	expireDecisions(): number;
	findMessage(id: number): Message | undefined;
	messageByRequest(requestId: string): Message | undefined;
	messagesWithMeta(path: string, value: string | number, o?: { kind?: MessageKind; status?: Message["status"]; limit?: number }): Message[];
}

/**
 * The whole domain behind one small surface. Rules enforced here, not in clients or adapters:
 *  - every read and write is scoped by realm; nothing crosses a realm boundary
 *  - every mutation names an actor that belongs to the realm
 *  - every mutation appends an event in the same transaction as the projection change
 *  - decisions are idempotent per key, first decision wins, authority and (optional) separation of duties are checked,
 *    and an away human (Echo) can never decide
 */
export class Core {
	readonly db: DatabaseSync;
	private listeners = new Set<Listener>();
	private pending: ActivityEvent[] = [];
	private depth = 0;
	now: () => number;

	constructor(db: DatabaseSync, opts: { now?: () => number } = {}) {
		this.db = db;
		this.now = opts.now ?? Date.now;
	}

	// ------------------------------------------------------------------ plumbing

	/** Run `fn` atomically. Events are published to subscribers only after the commit succeeded. */
	tx<T>(fn: () => T): T {
		if (this.depth > 0) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		this.depth++;
		try {
			const out = fn();
			this.db.exec("COMMIT");
			this.depth--;
			const sent = this.pending;
			this.pending = [];
			for (const e of sent) for (const l of this.listeners) try { l(e); } catch { /* a bad subscriber must not break the core */ }
			return out;
		} catch (e) {
			this.depth--;
			this.pending = [];
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	private emit(realmId: Id, type: string, actorId: Id, subjectKind: string, subjectId: Id, data: Record<string, unknown> = {}): ActivityEvent {
		const ts = this.now();
		if (data.spaceId === undefined) {
			const spaceId = this.spaceOfSubject(realmId, subjectKind, subjectId);
			if (spaceId) data = { ...data, spaceId };
		}
		const r = this.db.prepare("INSERT INTO events (realm_id, ts, type, actor_id, subject_kind, subject_id, data) VALUES (?,?,?,?,?,?,?)")
			.run(realmId, ts, type, actorId, subjectKind, subjectId, JSON.stringify(data));
		const e: ActivityEvent = { seq: Number(r.lastInsertRowid), realmId, ts, type, actorId, subjectKind, subjectId, data };
		this.pending.push(e);
		return e;
	}

	/** The space an event belongs to, so transports can filter per viewer. Realm-wide events have none. */
	private spaceOfSubject(realmId: Id, kind: string, id: Id): Id | null {
		const r = kind === "work"
			? this.db.prepare("SELECT space_id s FROM work WHERE realm_id = ? AND id = ?").get(realmId, id)
			: kind === "decision"
				? this.db.prepare("SELECT w.space_id s FROM decisions d JOIN work w ON w.realm_id = d.realm_id AND w.id = d.work_id WHERE d.realm_id = ? AND d.id = ?").get(realmId, id)
				: undefined;
		return ((r as Row | undefined)?.s as string | null) ?? null;
	}

	/** May this actor see this event? Space-scoped events follow the space's visibility; the rest is realm-wide. */
	canSeeEvent(e: ActivityEvent, actorId: Id): boolean {
		if (!this.getActor(e.realmId, actorId)) return false;
		const spaceId = e.data.spaceId;
		return typeof spaceId !== "string" || this.canSee(e.realmId, actorId, spaceId);
	}

	subscribe(l: Listener): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	/** Events of one realm after `seq`, oldest first. The basis of SSE resume. */
	events(realmId: Id, afterSeq = 0, limit = 500): ActivityEvent[] {
		return (this.db.prepare("SELECT * FROM events WHERE realm_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(realmId, afterSeq, limit) as Row[]).map(rowToEvent);
	}

	// ------------------------------------------------------------------ realms and actors

	createRealm(o: { id: Id; name: string; kind: RealmKind; policy?: Partial<RealmPolicy> }): Realm {
		return this.tx(() => {
			const have = this.getRealm(o.id);
			if (have) return have;
			if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(o.id)) throw invalid("realm id must be lowercase [a-z0-9._-]");
			const policy = { ...DEFAULT_POLICY, ...o.policy };
			const now = this.now();
			this.db.prepare("INSERT INTO realms (id, name, kind, policy, created_at) VALUES (?,?,?,?,?)").run(o.id, o.name, o.kind, JSON.stringify(policy), now);
			this.db.prepare("INSERT INTO actors (realm_id, id, kind, name, roles, created_at) VALUES (?,?,?,?,?,?)").run(o.id, SYSTEM, "system", "Entropi", "[]", now);
			this.emit(o.id, "realm.created", SYSTEM, "realm", o.id, { name: o.name, kind: o.kind, policy });
			return this.getRealm(o.id)!;
		});
	}

	getRealm(id: Id): Realm | undefined {
		const r = this.db.prepare("SELECT * FROM realms WHERE id = ?").get(id) as Row | undefined;
		return r ? { id: r.id, name: r.name, kind: r.kind, policy: JSON.parse(r.policy), createdAt: r.created_at } : undefined;
	}

	private realm(id: Id): Realm {
		const r = this.getRealm(id);
		if (!r) throw notFound(`realm ${id}`);
		return r;
	}

	listRealms(): Realm[] {
		return (this.db.prepare("SELECT id FROM realms ORDER BY created_at, id").all() as Row[]).map((r) => this.getRealm(r.id)!);
	}

	/**
	 * Add a member or change one (name, roles, profile). Membership and roles are authority, so only the system (bootstrap,
	 * seeding) or an admin may do it: a person cannot promote themselves by calling the core. Identity and kind never change.
	 * Nothing is written or announced when nothing changes.
	 */
	addActor(realmId: Id, o: { id: Id; kind: ActorKind; name: string; roles?: string[]; profile?: Record<string, unknown> }, by: Id): Actor {
		return this.tx(() => {
			this.realm(realmId);
			if (o.id === SYSTEM) throw forbidden("the system actor is reserved");
			if (by !== SYSTEM && !hasRole(this.actor(realmId, by), "admin")) throw forbidden("only an admin can add members or change roles");
			return this.upsertActor(realmId, o, by);
		});
	}

	/**
	 * The trusted path for people: the transport layer that authenticated someone (login, a trusted proxy header) records who
	 * they are and which roles their identity provider gives them. Humans only, and only what the provider vouches for; it
	 * is not a way to change an agent or to grant anything the provider did not. Never expose it to agents or to user input.
	 */
	syncIdentity(realmId: Id, o: { id: Id; name: string; roles: string[] }): Actor {
		return this.tx(() => {
			this.realm(realmId);
			if (o.id === SYSTEM || this.getActor(realmId, o.id)?.kind === "agent") throw forbidden(`${o.id} is not a person`);
			return this.upsertActor(realmId, { ...o, kind: "human" }, SYSTEM);
		});
	}

	private upsertActor(realmId: Id, o: { id: Id; kind: ActorKind; name: string; roles?: string[]; profile?: Record<string, unknown> }, by: Id): Actor {
		const cur = this.getActor(realmId, o.id);
		if (cur && cur.kind !== o.kind) throw conflict(`actor ${o.id} is a ${cur.kind}; identity cannot change kind`);
		const roles = [...new Set(o.roles ?? cur?.roles ?? [])].sort();
		const profile = o.profile ?? cur?.profile ?? {};
		if (cur && cur.name === o.name && JSON.stringify(cur.roles) === JSON.stringify(roles) && JSON.stringify(cur.profile) === JSON.stringify(profile)) return cur;
		if (cur) this.db.prepare("UPDATE actors SET name = ?, roles = ?, profile = ? WHERE realm_id = ? AND id = ?").run(o.name, JSON.stringify(roles), JSON.stringify(profile), realmId, o.id);
		else {
			this.db.prepare("INSERT INTO actors (realm_id, id, kind, name, roles, profile, created_at) VALUES (?,?,?,?,?,?,?)").run(realmId, o.id, o.kind, o.name, JSON.stringify(roles), JSON.stringify(profile), this.now());
			this.db.prepare("INSERT INTO presence (realm_id, actor_id, state, echo, updated_at) VALUES (?,?,?,0,?)").run(realmId, o.id, o.kind === "human" ? "active" : "idle", this.now());
		}
		this.emit(realmId, cur ? "actor.updated" : "actor.joined", by, "actor", o.id, { kind: o.kind, name: o.name, roles });
		return this.getActor(realmId, o.id)!;
	}

	getActor(realmId: Id, id: Id): Actor | undefined {
		const r = this.db.prepare("SELECT * FROM actors WHERE realm_id = ? AND id = ?").get(realmId, id) as Row | undefined;
		return r ? { realmId, id: r.id, kind: r.kind, name: r.name, roles: JSON.parse(r.roles), profile: JSON.parse(r.profile), createdAt: r.created_at } : undefined;
	}

	/** An actor that must be a member of the realm. The membership check every mutation starts with. */
	private actor(realmId: Id, id: Id): Actor {
		const a = this.getActor(realmId, id);
		if (!a) throw forbidden(`${id} is not a member of realm ${realmId}`);
		return a;
	}

	/** Changing work needs an agent, the system, or a person who can operate; viewers watch. */
	private requireAct(realmId: Id, by: Id): Actor {
		const a = this.actor(realmId, by);
		if (a.kind === "human" && !hasRole(a, "operator")) throw forbidden("viewers cannot change work");
		return a;
	}

	/** Work in a space the actor cannot see does not exist for them (404, not 403: no hint that it is there). */
	private seeWork(realmId: Id, by: Id, workId: Id): WorkItem {
		const w = this.getWork(realmId, workId);
		if (!w || (w.spaceId && !this.canSee(realmId, by, w.spaceId))) throw notFound(`work ${workId} in realm ${realmId}`);
		return w;
	}

	listActors(realmId: Id): Actor[] {
		return (this.db.prepare("SELECT id FROM actors WHERE realm_id = ? ORDER BY id").all(realmId) as Row[]).map((r) => this.getActor(realmId, r.id)!);
	}

	setPresence(realmId: Id, actorId: Id, state: PresenceState, by: Id, o: { echo?: boolean } = {}): Presence {
		return this.tx(() => {
			const a = this.actor(realmId, actorId);
			if (by !== actorId && by !== SYSTEM && !hasRole(this.actor(realmId, by), "admin")) throw forbidden("only you (or an admin) can change your presence");
			if (a.kind === "system") throw forbidden("the system actor has no presence");
			const humanStates: PresenceState[] = ["active", "away", "silent", "offline"];
			const agentStates: PresenceState[] = ["idle", "working", "waiting", "error", "offline"];
			if (!(a.kind === "human" ? humanStates : agentStates).includes(state)) throw invalid(`${state} is not a presence state for a ${a.kind}`);
			const echo = state === "away" && !!o.echo; // Echo exists only while away
			this.db.prepare("UPDATE presence SET state = ?, echo = ?, updated_at = ? WHERE realm_id = ? AND actor_id = ?").run(state, echo ? 1 : 0, this.now(), realmId, actorId);
			this.emit(realmId, "presence.changed", actorId, "actor", actorId, { state, echo });
			return this.getPresence(realmId, actorId)!;
		});
	}

	getPresence(realmId: Id, actorId: Id): Presence | undefined {
		const r = this.db.prepare("SELECT * FROM presence WHERE realm_id = ? AND actor_id = ?").get(realmId, actorId) as Row | undefined;
		return r ? { realmId, actorId, state: r.state, echo: !!r.echo, updatedAt: r.updated_at } : undefined;
	}

	// ------------------------------------------------------------------ work

	createWork(realmId: Id, o: { id?: Id; kind: string; title: string; goal?: string; ownerId?: Id | null; parentId?: Id | null; spaceId?: Id | null; state?: WorkState }, by: Id): WorkItem {
		return this.tx(() => {
			this.realm(realmId);
			this.requireAct(realmId, by);
			const id = o.id ?? `w_${randomUUID().slice(0, 8)}`;
			const have = this.getWork(realmId, id);
			if (have) return this.seeWork(realmId, by, id); // idempotent
			if (!o.title.trim()) throw invalid("work needs a title");
			if (o.ownerId) this.actor(realmId, o.ownerId);
			if (o.parentId && !this.getWork(realmId, o.parentId)) throw notFound(`parent work ${o.parentId}`);
			if (o.spaceId && !this.canSee(realmId, by, o.spaceId)) throw notFound(`space ${o.spaceId}`);
			const state = o.state ?? "queued";
			if (!WORK_STATES.includes(state)) throw invalid(`unknown work state ${state}`);
			const now = this.now();
			this.db.prepare("INSERT INTO work (realm_id, id, kind, title, goal, state, phase, owner_id, parent_id, space_id, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)")
				.run(realmId, id, o.kind, o.title, o.goal ?? "", state, o.ownerId ?? null, o.parentId ?? null, o.spaceId ?? null, now, now);
			this.emit(realmId, "work.created", by, "work", id, { kind: o.kind, title: o.title, state, parentId: o.parentId ?? null });
			return this.getWork(realmId, id)!;
		});
	}

	getWork(realmId: Id, id: Id): WorkItem | undefined {
		const r = this.db.prepare("SELECT * FROM work WHERE realm_id = ? AND id = ?").get(realmId, id) as Row | undefined;
		return r ? rowToWork(r) : undefined;
	}

	private work(realmId: Id, id: Id): WorkItem {
		const w = this.getWork(realmId, id);
		if (!w) throw notFound(`work ${id} in realm ${realmId}`);
		return w;
	}

	listWork(realmId: Id, f: { state?: WorkState; parentId?: Id | null } = {}): WorkItem[] {
		const rows = this.db.prepare("SELECT * FROM work WHERE realm_id = ? ORDER BY updated_at DESC, id").all(realmId) as Row[];
		return rows.map(rowToWork).filter((w) => (f.state ? w.state === f.state : true) && (f.parentId === undefined ? true : w.parentId === f.parentId));
	}

	setWorkState(realmId: Id, workId: Id, state: WorkState, by: Id, o: { phase?: string | null; reason?: string } = {}): WorkItem {
		return this.tx(() => {
			this.requireAct(realmId, by);
			return this.applyWorkState(realmId, this.seeWork(realmId, by, workId), state, by, o);
		});
	}

	/** The state change itself, after the caller's rights were checked (also used by the automatic decision <-> work coupling). */
	private applyWorkState(realmId: Id, w: WorkItem, state: WorkState, by: Id, o: { phase?: string | null; reason?: string }): WorkItem {
		const workId = w.id;
		{
			if (!WORK_STATES.includes(state)) throw invalid(`unknown work state ${state}`);
			if (TERMINAL.includes(w.state) && state !== w.state) throw conflict(`work ${workId} is ${w.state}; terminal states are final`);
			const phase = o.phase === undefined ? w.phase : o.phase;
			if (state === w.state && phase === w.phase) return w;
			this.db.prepare("UPDATE work SET state = ?, phase = ?, updated_at = ? WHERE realm_id = ? AND id = ?").run(state, phase, this.now(), realmId, workId);
			this.emit(realmId, "work.state", by, "work", workId, { from: w.state, to: state, phase, reason: o.reason ?? null });
			// Attention follows state: failures and blockers surface, and resolve when the work moves on.
			if (state === "failed") this.raise(realmId, "failure", workId, workId, `${w.title} failed${o.reason ? `: ${o.reason}` : ""}`);
			else this.resolve(realmId, "failure", workId);
			if (state === "blocked") this.raise(realmId, "blocked", workId, workId, `${w.title} is blocked${o.reason ? `: ${o.reason}` : ""}`);
			else this.resolve(realmId, "blocked", workId);
			if (TERMINAL.includes(state)) this.cancelOpenDecisions(realmId, workId, by, `work ${state}`);
			return this.getWork(realmId, workId)!;
		}
	}

	// ------------------------------------------------------------------ external references

	linkRef(realmId: Id, workId: Id, o: { source: string; externalId: string; label?: string; url?: string; state?: string }, by: Id): ExternalRef {
		return this.tx(() => {
			this.requireAct(realmId, by);
			this.seeWork(realmId, by, workId);
			const cur = this.getRef(realmId, o.source, o.externalId);
			if (cur && cur.workId !== workId) throw conflict(`${o.source}:${o.externalId} is already linked to work ${cur.workId}`);
			if (!cur) {
				this.db.prepare("INSERT INTO external_refs (realm_id, work_id, source, external_id, label, url, state, observed_at) VALUES (?,?,?,?,?,?,?,?)")
					.run(realmId, workId, o.source, o.externalId, o.label ?? null, o.url ?? null, o.state ?? null, o.state ? this.now() : null);
				this.emit(realmId, "ref.linked", by, "work", workId, { source: o.source, externalId: o.externalId, label: o.label ?? null });
			}
			return this.getRef(realmId, o.source, o.externalId)!;
		});
	}

	getRef(realmId: Id, source: string, externalId: string): ExternalRef | undefined {
		const r = this.db.prepare("SELECT * FROM external_refs WHERE realm_id = ? AND source = ? AND external_id = ?").get(realmId, source, externalId) as Row | undefined;
		return r ? rowToRef(r) : undefined;
	}

	refsOf(realmId: Id, workId: Id): ExternalRef[] {
		return (this.db.prepare("SELECT * FROM external_refs WHERE realm_id = ? AND work_id = ? ORDER BY source, external_id").all(realmId, workId) as Row[]).map(rowToRef);
	}

	/** A source reports the state of something it owns. Cached here; only a change produces an event. */
	observeRef(realmId: Id, source: string, externalId: string, state: string, by: Id): ExternalRef {
		return this.tx(() => {
			this.requireAct(realmId, by);
			const cur = this.getRef(realmId, source, externalId);
			if (!cur) throw notFound(`ref ${source}:${externalId}`);
			this.seeWork(realmId, by, cur.workId);
			if (cur.state === state) return cur;
			this.db.prepare("UPDATE external_refs SET state = ?, observed_at = ? WHERE realm_id = ? AND source = ? AND external_id = ?").run(state, this.now(), realmId, source, externalId);
			this.emit(realmId, "ref.observed", by, "work", cur.workId, { source, externalId, from: cur.state, to: state });
			return this.getRef(realmId, source, externalId)!;
		});
	}

	// ------------------------------------------------------------------ decisions

	/** Ask a person. Idempotent per (realm, key): a retried caller gets the original request back. */
	requestDecision(realmId: Id, o: {
		key: string; workId: Id; question: string; options?: string[]; context?: Record<string, unknown>;
		urgency?: DecisionRequest["urgency"]; requiredAuthority?: string; expiresAt?: number | null;
	}, by: Id): { decision: DecisionRequest; created: boolean } {
		return this.tx(() => {
			this.requireAct(realmId, by);
			const have = this.decisionByKey(realmId, o.key);
			if (have) { this.seeWork(realmId, by, have.workId); return { decision: have, created: false }; }
			const w = this.seeWork(realmId, by, o.workId);
			if (o.urgency !== undefined && !URGENCIES.includes(o.urgency)) throw invalid(`urgency must be one of: ${URGENCIES.join(", ")}`);
			if (TERMINAL.includes(w.state)) throw conflict(`work ${w.id} is ${w.state}`);
			const options = o.options ?? ["approve", "reject"];
			if (options.length < 2 || new Set(options).size !== options.length) throw invalid("a decision needs at least two distinct options");
			if (!o.question.trim()) throw invalid("a decision needs a question");
			const id = `d_${randomUUID().slice(0, 8)}`;
			this.db.prepare(`INSERT INTO decisions (realm_id, id, key, work_id, question, options, context, urgency, required_authority, requested_by, status, created_at, expires_at)
				VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?, ?)`)
				.run(realmId, id, o.key, o.workId, o.question, JSON.stringify(options), JSON.stringify(o.context ?? {}), o.urgency ?? "normal", o.requiredAuthority ?? "approver", by, this.now(), o.expiresAt ?? null);
			this.emit(realmId, "decision.requested", by, "decision", id, { workId: o.workId, question: o.question, options, urgency: o.urgency ?? "normal", requiredAuthority: o.requiredAuthority ?? "approver" });
			if (w.spaceId) {
				const card = this.insertMessage(realmId, w.spaceId, this.actor(realmId, by), "decision", o.question, {
					decisionId: id, status: "open", options, context: o.context ?? {}, urgency: o.urgency ?? "normal", requiredAuthority: o.requiredAuthority ?? "approver", workId: o.workId,
				}, "done", null);
				this.db.prepare("UPDATE decisions SET message_id = ? WHERE realm_id = ? AND id = ?").run(card.id, realmId, id);
			}
			this.raise(realmId, "decision", o.workId, id, o.question);
			if (w.state !== "waiting") this.applyWorkState(realmId, w, "waiting", by, { reason: "decision requested" });
			return { decision: this.getDecision(realmId, id)!, created: true };
		});
	}

	getDecision(realmId: Id, id: Id): DecisionRequest | undefined {
		const r = this.db.prepare("SELECT * FROM decisions WHERE realm_id = ? AND id = ?").get(realmId, id) as Row | undefined;
		return r ? rowToDecision(r) : undefined;
	}

	decisionByKey(realmId: Id, key: string): DecisionRequest | undefined {
		const r = this.db.prepare("SELECT * FROM decisions WHERE realm_id = ? AND key = ?").get(realmId, key) as Row | undefined;
		return r ? rowToDecision(r) : undefined;
	}

	/** Who may decide this: authority role, not the requester when separation of duties applies, a human, and present. */
	canDecide(realmId: Id, decision: DecisionRequest, actorId: Id): { ok: true } | { ok: false; reason: string } {
		const realm = this.realm(realmId);
		const a = this.getActor(realmId, actorId);
		if (!a) return { ok: false, reason: `${actorId} is not a member of realm ${realmId}` };
		if (a.kind !== "human") return { ok: false, reason: "only a human can decide" };
		if (!hasRole(a, decision.requiredAuthority)) return { ok: false, reason: `needs the ${decision.requiredAuthority} role` };
		if (realm.policy.separationOfDuties && decision.requestedBy === actorId) return { ok: false, reason: "requester cannot decide their own request" };
		const p = this.getPresence(realmId, actorId);
		if (p && p.state !== "active") return { ok: false, reason: p.echo ? "away: Echo may answer questions but never decide" : `presence is ${p.state}` };
		return { ok: true };
	}

	/**
	 * First decision wins; a second one conflicts rather than silently overwriting. The checks run in this order so the answer
	 * never leaks or misleads: does it exist for you (else 404), is it still open and not past its deadline (else 409, even for
	 * someone who could not have decided it), may you decide it (else 403), is the answer one of the options (else 400).
	 */
	decide(realmId: Id, decisionId: Id, actorId: Id, answer: string, note?: string): DecisionRequest {
		this.expireDecisions(); // a deadline that has passed counts now, not whenever a timer next runs
		return this.tx(() => {
			this.actor(realmId, actorId);
			const d = this.getDecision(realmId, decisionId);
			if (!d) throw notFound(`decision ${decisionId} in realm ${realmId}`);
			const w = this.seeWork(realmId, actorId, d.workId);
			if (d.status !== "open") throw conflict(`decision ${decisionId} is already ${d.status}${d.decidedBy ? ` (by ${d.decidedBy})` : ""}`);
			const ok = this.canDecide(realmId, d, actorId);
			if (!ok.ok) throw forbidden(ok.reason);
			if (!d.options.includes(answer)) throw invalid(`answer must be one of: ${d.options.join(", ")}`);
			this.db.prepare("UPDATE decisions SET status = 'decided', answer = ?, decided_by = ?, note = ?, decided_at = ? WHERE realm_id = ? AND id = ? AND status = 'open'")
				.run(answer, actorId, note ?? null, this.now(), realmId, decisionId);
			this.emit(realmId, "decision.decided", actorId, "decision", decisionId, { workId: d.workId, answer, note: note ?? null });
			this.syncDecisionCard(realmId, decisionId);
			this.resolve(realmId, "decision", decisionId);
			if (w.state === "waiting" && this.openDecisions(realmId, d.workId).length === 0) this.applyWorkState(realmId, w, "working", actorId, { reason: `decided: ${answer}` });
			return this.getDecision(realmId, decisionId)!;
		});
	}

	openDecisions(realmId: Id, workId?: Id): DecisionRequest[] {
		const rows = workId
			? this.db.prepare("SELECT * FROM decisions WHERE realm_id = ? AND status = 'open' AND work_id = ? ORDER BY created_at, id").all(realmId, workId)
			: this.db.prepare("SELECT * FROM decisions WHERE realm_id = ? AND status = 'open' ORDER BY created_at, id").all(realmId);
		return (rows as Row[]).map(rowToDecision);
	}

	private cancelOpenDecisions(realmId: Id, workId: Id, by: Id, why: string) {
		for (const d of this.openDecisions(realmId, workId)) {
			this.db.prepare("UPDATE decisions SET status = 'cancelled', decided_at = ? WHERE realm_id = ? AND id = ?").run(this.now(), realmId, d.id);
			this.emit(realmId, "decision.cancelled", by, "decision", d.id, { workId, why });
			this.syncDecisionCard(realmId, d.id);
			this.resolve(realmId, "decision", d.id);
		}
	}

	/** Expire open decisions whose deadline passed. Call from a timer; the core never runs one itself. */
	private expireDecisions(): number {
		return this.tx(() => {
			const rows = this.db.prepare("SELECT * FROM decisions WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?").all(this.now()) as Row[];
			for (const r of rows) {
				this.db.prepare("UPDATE decisions SET status = 'expired', decided_at = ? WHERE realm_id = ? AND id = ?").run(this.now(), r.realm_id, r.id);
				this.emit(r.realm_id, "decision.expired", SYSTEM, "decision", r.id, { workId: r.work_id });
				this.syncDecisionCard(r.realm_id, r.id);
				this.resolve(r.realm_id, "decision", r.id);
			}
			return rows.length;
		});
	}


	// ------------------------------------------------------------------ spaces (channels)

	/** Idempotent per id. A DM belongs to one human and holds exactly one agent. */
	createSpace(realmId: Id, o: { id?: Id; kind: SpaceKind; name: string; topic?: string; ownerId?: Id | null; agentIds?: Id[] }, by: Id): { space: Space; created: boolean } {
		return this.tx(() => {
			this.realm(realmId);
			const actor = this.actor(realmId, by);
			if (!SPACE_KINDS.includes(o.kind)) throw invalid(`space kind must be one of: ${SPACE_KINDS.join(", ")}`);
			const id = o.id ?? slug(o.name);
			if (id.length < 2) throw invalid("space name must have at least 2 letters or digits");
			const power = by === SYSTEM || hasRole(actor, "admin");
			// Standing rooms are for admins; cases for anyone who can operate (agents too); a private chat only for its own owner.
			if (!power && o.kind === "standing") throw forbidden("only an admin can create a standing room");
			if (!power && o.kind === "case" && actor.kind === "human" && !hasRole(actor, "operator")) throw forbidden("viewers cannot open cases");
			if (!power && o.kind === "dm" && o.ownerId !== by) throw forbidden("a private chat can only be created for yourself");
			const have = this.getSpace(realmId, id);
			if (have) {
				if (have.kind !== o.kind || have.ownerId !== (o.ownerId ?? null)) throw conflict(`space ${id} already exists with a different kind or owner`);
				if (!this.canSee(realmId, by, id)) throw notFound(`space ${id}`);
				return { space: have, created: false };
			}
			const agentIds = [...new Set(o.agentIds ?? [])];
			for (const a of agentIds) if (this.actor(realmId, a).kind !== "agent") throw invalid(`${a} is not an agent`);
			if (o.kind === "dm") {
				if (!o.ownerId || this.actor(realmId, o.ownerId).kind !== "human") throw invalid("a DM needs a human owner");
				if (agentIds.length !== 1) throw invalid("a DM holds exactly one agent");
			} else if (o.ownerId) throw invalid("only a DM has an owner");
			this.db.prepare("INSERT INTO spaces (realm_id, id, kind, name, topic, status, owner_id, agent_ids, created_by, created_at) VALUES (?,?,?,?,?,'open',?,?,?,?)")
				.run(realmId, id, o.kind, o.name, (o.topic ?? "").slice(0, 200), o.ownerId ?? null, JSON.stringify(agentIds), by, this.now());
			// A DM's existence is private too: its event carries the space id, so only the owner's stream sees it.
			this.emit(realmId, "space.created", by, "space", id, { spaceId: id, kind: o.kind, name: o.name, agentIds });
			return { space: this.getSpace(realmId, id)!, created: true };
		});
	}

	getSpace(realmId: Id, id: Id): Space | undefined {
		const r = this.db.prepare("SELECT * FROM spaces WHERE realm_id = ? AND id = ?").get(realmId, id) as Row | undefined;
		return r ? rowToSpace(r) : undefined;
	}

	private space(realmId: Id, id: Id): Space {
		const s = this.getSpace(realmId, id);
		if (!s) throw notFound(`space ${id} in realm ${realmId}`);
		return s;
	}

	/** DMs are visible to their owner and their agent only; every other space to every member of the realm. */
	canSee(realmId: Id, actorId: Id, spaceId: Id): boolean {
		const a = this.getActor(realmId, actorId);
		const s = this.getSpace(realmId, spaceId);
		if (!a || !s) return false;
		if (a.kind === "system") return true;
		return s.kind !== "dm" || s.ownerId === actorId || s.agentIds.includes(actorId);
	}

	private canSeeWork(realmId: Id, actorId: Id, workId: Id): boolean {
		const w = this.getWork(realmId, workId);
		return !w?.spaceId || this.canSee(realmId, actorId, w.spaceId);
	}

	listSpaces(realmId: Id, forActor: Id, includeArchived = true): Space[] {
		const rows = this.db.prepare("SELECT * FROM spaces WHERE realm_id = ? ORDER BY created_at, id").all(realmId) as Row[];
		const order = { standing: 0, case: 1, dm: 2 } as const;
		return rows.map(rowToSpace)
			.filter((s) => (includeArchived || s.status === "open") && this.canSee(realmId, forActor, s.id))
			.sort((a, b) => order[a.kind] - order[b.kind] || a.createdAt - b.createdAt);
	}

	/** Only cases end; standing rooms and DMs are permanent. Archived spaces stay readable but take no new messages. */
	setSpaceStatus(realmId: Id, spaceId: Id, status: "open" | "archived", by: Id): Space {
		return this.tx(() => {
			const actor = this.actor(realmId, by);
			const s = this.space(realmId, spaceId);
			if (!this.canSee(realmId, by, spaceId)) throw notFound(`space ${spaceId} in realm ${realmId}`);
			if (s.kind !== "case") throw invalid("only case spaces can be archived");
			if (actor.kind === "human" && !hasRole(actor, "operator")) throw forbidden("operators only");
			if (s.status !== status) {
				this.db.prepare("UPDATE spaces SET status = ? WHERE realm_id = ? AND id = ?").run(status, realmId, spaceId);
				this.emit(realmId, `space.${status === "archived" ? "archived" : "reopened"}`, by, "space", spaceId, { spaceId });
			}
			return this.space(realmId, spaceId);
		});
	}

	canPost(realmId: Id, actorId: Id, spaceId: Id): boolean {
		const a = this.getActor(realmId, actorId);
		const s = this.getSpace(realmId, spaceId);
		if (!a || !s || s.status !== "open" || !this.canSee(realmId, actorId, spaceId)) return false;
		if (a.kind === "system") return true;
		if (a.kind === "agent") return s.agentIds.includes(actorId);
		return hasRole(a, "operator");
	}

	// ------------------------------------------------------------------ messages

	private insertMessage(realmId: Id, spaceId: Id, author: Actor, kind: MessageKind, text: string, meta: Record<string, unknown>, status: Message["status"], requestId: string | null, dispatch = 0): Message {
		const now = this.now();
		const r = this.db.prepare("INSERT INTO messages (realm_id, space_id, author_id, author_name, kind, text, meta, status, request_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
			.run(realmId, spaceId, author.id, author.name, kind, text, JSON.stringify(meta), status, requestId, now, now);
		const m = this.getMessage(realmId, Number(r.lastInsertRowid))!;
		this.emit(realmId, "message.posted", author.id, "message", String(m.id), { spaceId, kind, status, dispatch });
		return m;
	}

	/** Idempotent per requestId, so a retried agent run does not post twice. */
	postMessage(realmId: Id, spaceId: Id, by: Id, o: { text: string; kind?: MessageKind; meta?: Record<string, unknown>; status?: Message["status"]; requestId?: string; dispatchTo?: Id[]; depth?: number }): { message: Message; created: boolean } {
		return this.tx(() => {
			const actor = this.actor(realmId, by);
			this.space(realmId, spaceId);
			if (!this.canSee(realmId, by, spaceId)) throw notFound(`space ${spaceId} in realm ${realmId}`);
			if (!this.canPost(realmId, by, spaceId)) throw forbidden(this.getSpace(realmId, spaceId)!.status === "archived" ? "this case is archived; reopen it to continue" : "you cannot post here");
			if (o.requestId) {
				const dup = this.db.prepare("SELECT id FROM messages WHERE realm_id = ? AND request_id = ?").get(realmId, o.requestId) as Row | undefined;
				if (dup) return { message: this.getMessage(realmId, dup.id)!, created: false };
			}
			if (!o.text.trim() && o.status !== "working") throw invalid("empty message");
			const targets = [...new Set(o.dispatchTo ?? [])];
			const sp = this.getSpace(realmId, spaceId)!;
			for (const t of targets) if (!sp.agentIds.includes(t) || t === by) throw invalid(`${t} cannot be woken in ${spaceId}`);
			const message = this.insertMessage(realmId, spaceId, actor, o.kind ?? (actor.kind === "agent" ? "agent" : "chat"), o.text, o.meta ?? {}, o.status ?? "done", o.requestId ?? null, targets.length);
			for (const t of targets) this.queueOutbox(realmId, message.id, t, o.depth ?? 0);
			return { message, created: true };
		});
	}

	getMessage(realmId: Id, id: number): Message | undefined {
		const r = this.db.prepare("SELECT * FROM messages WHERE realm_id = ? AND id = ?").get(realmId, id) as Row | undefined;
		return r ? rowToMessage(r) : undefined;
	}

	/**
	 * The author (an agent still writing) updates its message. Streaming updates change the row silently; only the
	 * working -> done transition is a fact worth a log event, so the log is not flooded with token deltas.
	 */
	updateMessage(realmId: Id, id: number, by: Id, patch: { text?: string; meta?: Record<string, unknown>; status?: Message["status"] }): Message {
		return this.tx(() => {
			this.actor(realmId, by);
			const m = this.getMessage(realmId, id);
			if (!m || !this.canSee(realmId, by, m.spaceId)) throw notFound(`message ${id}`);
			if (m.authorId !== by && by !== SYSTEM) throw forbidden("only the author can edit a message");
			const status = patch.status ?? m.status;
			this.db.prepare("UPDATE messages SET text = ?, meta = ?, status = ?, updated_at = ? WHERE realm_id = ? AND id = ?")
				.run(patch.text ?? m.text, JSON.stringify(patch.meta ?? m.meta), status, this.now(), realmId, id);
			if (m.status === "working" && status === "done") this.emit(realmId, "message.completed", by, "message", String(id), { spaceId: m.spaceId });
			return this.getMessage(realmId, id)!;
		});
	}

	/** Newest `limit` messages the viewer may see, oldest first. */
	listMessages(realmId: Id, spaceId: Id, forActor: Id, limit = 200): Message[] {
		if (!this.canSee(realmId, forActor, spaceId)) throw notFound(`space ${spaceId} in realm ${realmId}`);
		const rows = this.db.prepare("SELECT * FROM (SELECT * FROM messages WHERE realm_id = ? AND space_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(realmId, spaceId, limit) as Row[];
		return rows.map(rowToMessage);
	}

	/** @handles in a message, split into agents present in the space and agents of the realm that are not. */
	mentions(realmId: Id, spaceId: Id, text: string): { present: Id[]; absent: Id[] } {
		const s = this.space(realmId, spaceId);
		const handles = new Set([...text.matchAll(/@([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()));
		const agents = this.listActors(realmId).filter((a) => a.kind === "agent");
		const present: Id[] = [], absent: Id[] = [];
		for (const a of agents) {
			if (!handles.has(handleOf(a.id))) continue;
			(s.agentIds.includes(a.id) ? present : absent).push(a.id);
		}
		return { present, absent };
	}

	/** Keep the approval card in a space in line with its decision. */
	private syncDecisionCard(realmId: Id, decisionId: Id) {
		const d = this.getDecision(realmId, decisionId);
		const mid = (this.db.prepare("SELECT message_id m FROM decisions WHERE realm_id = ? AND id = ?").get(realmId, decisionId) as Row | undefined)?.m as number | null | undefined;
		const m = mid ? this.getMessage(realmId, mid) : undefined;
		if (!d || !m) return;
		const by = d.decidedBy ? this.getActor(realmId, d.decidedBy) : undefined;
		this.db.prepare("UPDATE messages SET meta = ?, updated_at = ? WHERE realm_id = ? AND id = ?")
			.run(JSON.stringify({ ...m.meta, status: d.status, answer: d.answer, decidedBy: by?.name ?? d.decidedBy, decidedById: d.decidedBy, note: d.note }), this.now(), realmId, m.id);
		this.emit(realmId, "message.updated", d.decidedBy ?? SYSTEM, "message", String(m.id), { spaceId: m.spaceId });
	}


	// ------------------------------------------------------------------ attachments

	/** Register an uploaded file (stored elsewhere) against a space. Same bytes uploaded twice to one space is one attachment. */
	addAttachment(realmId: Id, spaceId: Id, by: Id, o: { id: Id; name: string; mime: string; size: number }): Attachment {
		return this.tx(() => {
			this.actor(realmId, by);
			if (!this.canPost(realmId, by, spaceId)) throw forbidden("you cannot post here");
			this.db.prepare("INSERT OR IGNORE INTO attachments (realm_id, id, space_id, name, mime, size, owner_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(realmId, o.id, spaceId, o.name.slice(0, 120), o.mime, o.size, by, this.now());
			return this.getAttachment(realmId, spaceId, o.id, by)!;
		});
	}

	/** Visible only to people who can see the space the file was shared in. */
	getAttachment(realmId: Id, spaceId: Id, id: Id, forActor: Id): Attachment | undefined {
		if (!this.canSee(realmId, forActor, spaceId)) return undefined;
		const r = this.db.prepare("SELECT * FROM attachments WHERE realm_id = ? AND space_id = ? AND id = ?").get(realmId, spaceId, id) as Row | undefined;
		return r ? { realmId, id: r.id, spaceId, name: r.name, mime: r.mime, size: r.size, ownerId: r.owner_id, createdAt: r.created_at } : undefined;
	}

	/** Resolve a file id from any space the viewer may see (for the plain /files/:id URL). */
	findAttachment(realmId: Id, id: Id, forActor: Id): Attachment | undefined {
		const rows = this.db.prepare("SELECT space_id FROM attachments WHERE realm_id = ? AND id = ?").all(realmId, id) as Row[];
		for (const r of rows) { const a = this.getAttachment(realmId, r.space_id, id, forActor); if (a) return a; }
		return undefined;
	}

	// ------------------------------------------------------------------ audit

	/** Record something a person or system did that is not a state change by itself (stop, compact...). */
	record(realmId: Id, by: Id, type: string, subjectKind: string, subjectId: Id, data: Record<string, unknown> = {}): ActivityEvent {
		return this.tx(() => {
			this.requireAct(realmId, by);
			return this.emit(realmId, type, by, subjectKind, subjectId, data);
		});
	}

	// ------------------------------------------------------------------ outbox

	private queueOutbox(realmId: Id, messageId: number, agentId: Id, depth: number) {
		this.db.prepare("INSERT OR IGNORE INTO outbox (realm_id, message_id, agent_id, depth, created_at) VALUES (?,?,?,?,?)").run(realmId, messageId, agentId, depth, this.now());
	}

	/** Hand-overs not yet confirmed by a runtime, oldest first. The runtime must be idempotent per (message, agent). */
	private pendingOutbox(limit = 50): OutboxItem[] {
		const rows = this.db.prepare(`SELECT o.id, o.realm_id, o.message_id, o.agent_id, o.depth, o.attempts, m.space_id, m.text, m.author_id
			FROM outbox o JOIN messages m ON m.realm_id = o.realm_id AND m.id = o.message_id WHERE o.status = 'pending' ORDER BY o.id LIMIT ?`).all(limit) as Row[];
		return rows.map((r) => ({ id: r.id, realmId: r.realm_id, messageId: r.message_id, spaceId: r.space_id, agentId: r.agent_id, depth: r.depth, text: r.text, from: r.author_id, attempts: r.attempts }));
	}

	private markOutbox(id: number, status: "sent" | "failed", error?: string) {
		this.db.prepare("UPDATE outbox SET status = ?, error = ?, done_at = ? WHERE id = ?").run(status, error ?? null, this.now(), id);
	}

	private bumpOutbox(id: number, error: string): number {
		this.db.prepare("UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?").run(error, id);
		return (this.db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as Row).attempts;
	}

	/** The message with this id if it is still being written. */
	private findMessage(messageId: number): Message | undefined {
		const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Row | undefined;
		return r ? rowToMessage(r) : undefined;
	}

	/** Withdraw hand-overs that were queued by one run (stop propagating down a delegation chain). Returns how many. */
	private cancelOutboxFromRun(runId: string, reason: string): number {
		const rows = this.db.prepare(`SELECT o.id FROM outbox o JOIN messages m ON m.realm_id = o.realm_id AND m.id = o.message_id
			WHERE o.status = 'pending' AND json_extract(m.meta, '$.runId') = ?`).all(runId) as Row[];
		for (const r of rows) this.markOutbox(r.id, "failed", reason);
		return rows.length;
	}

	/** Agent messages still being written: what a restarted runtime has to pick up again. */
	private workingMessages(): Message[] {
		return (this.db.prepare("SELECT * FROM messages WHERE status = 'working' ORDER BY id").all() as Row[]).map(rowToMessage);
	}

	// ------------------------------------------------------------------ delegation

	/**
	 * One agent hands work to another in a space. The rules live here, not in the agent's tool: no DMs, no self, both
	 * present, bounded depth, no repeating the same ask, and a rate limit per space. All counted from the event log, so
	 * limits survive restarts and replays are idempotent per requestId.
	 */
	delegate(realmId: Id, o: { spaceId: Id; from: Id; to: Id; request: string; requestId: string; depth?: number; runId?: string }): { created: boolean; depth: number; messageId: number | null } {
		return this.tx(() => {
			const realm = this.realm(realmId);
			const from = this.actor(realmId, o.from);
			const to = this.actor(realmId, o.to);
			const s = this.space(realmId, o.spaceId);
			const depth = o.depth ?? 0;
			if (from.kind !== "agent") throw forbidden("only agents delegate; people @mention");
			if (s.kind === "dm") throw forbidden("a private chat cannot hand work to other agents");
			if (to.kind !== "agent") throw invalid("work can only be delegated to an agent");
			if (to.id === from.id) throw invalid("cannot ask yourself");
			if (!s.agentIds.includes(from.id)) throw forbidden(`${from.id} is not in ${s.id}`);
			if (!s.agentIds.includes(to.id)) throw notFound(`agent ${handleOf(to.id)} in ${s.id}. Present: ${s.agentIds.map(handleOf).join(", ")}`);
			const dup = this.db.prepare("SELECT 1 FROM events WHERE realm_id = ? AND type = 'delegation.requested' AND json_extract(data, '$.requestId') = ?").get(realmId, o.requestId);
			if (dup) return { created: false, depth: depth + 1, messageId: (this.db.prepare("SELECT id FROM messages WHERE realm_id = ? AND request_id = ?").get(realmId, `delegate:${o.requestId}`) as Row | undefined)?.id ?? null };
			if (depth >= realm.policy.maxDelegationDepth) throw forbidden(`delegation depth limit (${realm.policy.maxDelegationDepth}) reached. Do not ask other agents again: summarize what is known and blocked, and let a human decide.`);
			if (o.runId) {
				const used = (this.db.prepare("SELECT COUNT(*) n FROM events WHERE realm_id = ? AND type = 'delegation.requested' AND json_extract(data, '$.runId') = ?").get(realmId, o.runId) as Row).n as number;
				if (used >= realm.policy.maxDelegationsPerRun) throw forbidden(`you already handed work on ${used} time(s) in this turn (limit ${realm.policy.maxDelegationsPerRun}). Stop delegating: summarize what you know and what is blocked, and let a human decide.`);
			}
			const hash = `${to.id}:${o.request.trim().toLowerCase().slice(0, 160)}`;
			const since = this.now() - 600_000;
			const recent = this.db.prepare("SELECT data FROM events WHERE realm_id = ? AND type = 'delegation.requested' AND ts >= ? AND json_extract(data, '$.spaceId') = ?").all(realmId, since, o.spaceId) as Row[];
			if (recent.some((r) => JSON.parse(r.data).hash === hash)) throw conflict(`@${handleOf(to.id)} was already asked the same thing recently; wait for the answer instead of repeating it`);
			if (recent.length >= realm.policy.delegationsPer10Min) throw forbidden("delegation limit reached in this space; ask a human to continue");
			this.emit(realmId, "delegation.requested", from.id, "space", o.spaceId, { spaceId: o.spaceId, to: to.id, depth: depth + 1, hash, requestId: o.requestId, runId: o.runId ?? null });
			// The hand-over is a message people can read, and the wake-up is queued in the same transaction.
			const { message } = this.postMessage(realmId, o.spaceId, from.id, {
				kind: "delegation", text: o.request, meta: { to: handleOf(to.id), toId: to.id, requestId: o.requestId, runId: o.runId ?? null }, requestId: `delegate:${o.requestId}`, dispatchTo: [to.id], depth: depth + 1,
			});
			return { created: true, depth: depth + 1, messageId: message.id };
		});
	}

	// ------------------------------------------------------------------ attention

	private raise(realmId: Id, kind: AttentionKind, workId: Id, subjectId: Id, summary: string) {
		const open = this.db.prepare("SELECT 1 FROM attention WHERE realm_id = ? AND kind = ? AND subject_id = ? AND resolved_at IS NULL").get(realmId, kind, subjectId);
		if (open) return;
		const id = `a_${randomUUID().slice(0, 8)}`;
		this.db.prepare("INSERT INTO attention (realm_id, id, kind, work_id, subject_id, summary, created_at) VALUES (?,?,?,?,?,?,?)").run(realmId, id, kind, workId, subjectId, summary, this.now());
		this.emit(realmId, "attention.raised", SYSTEM, "work", workId, { attentionId: id, kind, summary });
	}

	private resolve(realmId: Id, kind: AttentionKind, subjectId: Id) {
		const rows = this.db.prepare("SELECT id, work_id FROM attention WHERE realm_id = ? AND kind = ? AND subject_id = ? AND resolved_at IS NULL").all(realmId, kind, subjectId) as Row[];
		for (const r of rows) {
			this.db.prepare("UPDATE attention SET resolved_at = ? WHERE realm_id = ? AND id = ?").run(this.now(), realmId, r.id);
			this.emit(realmId, "attention.resolved", SYSTEM, "work", r.work_id, { attentionId: r.id, kind });
		}
	}

	openAttention(realmId: Id): AttentionItem[] {
		return (this.db.prepare("SELECT * FROM attention WHERE realm_id = ? AND resolved_at IS NULL ORDER BY created_at, id").all(realmId) as Row[]).map(rowToAttention);
	}

	/**
	 * The human view, compiled deterministically from state: what needs this person, what is broken, what is moving,
	 * and only a count for everything that is fine. Decisions this actor may not decide are not shown to them.
	 */
	focus(realmId: Id, actorId: Id): Focus {
		this.realm(realmId);
		const actor = this.actor(realmId, actorId);
		const attention = this.openAttention(realmId).filter((a) => this.canSeeWork(realmId, actorId, a.workId));
		const needsYou: Focus["needsYou"] = [];
		for (const item of attention.filter((a) => a.kind === "decision")) {
			const d = this.getDecision(realmId, item.subjectId);
			if (d && d.status === "open" && this.canSeeWork(realmId, actorId, d.workId) && (actor.kind !== "human" ? false : this.canDecideIgnoringPresence(realmId, d, actor))) needsYou.push({ decision: d, attention: item, spaceId: this.getWork(realmId, d.workId)?.spaceId ?? null });
		}
		const urgency = { high: 0, normal: 1, low: 2 } as const;
		needsYou.sort((x, y) => urgency[x.decision.urgency] - urgency[y.decision.urgency] || x.attention.createdAt - y.attention.createdAt);
		const all = this.listWork(realmId).filter((w) => !TERMINAL.includes(w.state) && this.canSeeWork(realmId, actorId, w.id));
		const working = all.filter((w) => w.state === "working");
		const waiting = all.filter((w) => w.state === "waiting" && !needsYou.some((n) => n.decision.workId === w.id));
		const shown = new Set([...working, ...waiting].map((w) => w.id));
		return {
			realmId,
			needsYou,
			attention: attention.filter((a) => a.kind !== "decision"),
			working,
			waiting,
			background: { count: all.filter((w) => !shown.has(w.id) && w.state === "queued").length },
		};
	}

	/** Away humans still *see* what needs them; presence only blocks deciding. */
	private canDecideIgnoringPresence(realmId: Id, d: DecisionRequest, a: Actor): boolean {
		const policy = this.realm(realmId).policy;
		if (!hasRole(a, d.requiredAuthority)) return false;
		return !(policy.separationOfDuties && d.requestedBy === a.id);
	}
	/** The reply row or any message by its idempotency key (unique per realm; keys embed ids, so they do not collide across realms). */
	private messageByRequest(requestId: string): Message | undefined {
		const r = this.db.prepare("SELECT * FROM messages WHERE request_id = ?").get(requestId) as Row | undefined;
		return r ? rowToMessage(r) : undefined;
	}

	/** Messages whose `meta` holds `value` at a dotted path (e.g. "pi.thread"), newest first. The path is validated, never interpolated. */
	private messagesWithMeta(path: string, value: string | number, o: { kind?: MessageKind; status?: Message["status"]; limit?: number } = {}): Message[] {
		if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(path)) throw invalid("bad meta path");
		const rows = this.db.prepare(`SELECT * FROM messages WHERE json_extract(meta, '$.${path}') = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`)
			.all(value, o.kind ?? null, o.kind ?? null, o.status ?? null, o.status ?? null, o.limit ?? 50) as Row[];
		return rows.map(rowToMessage);
	}

	/**
	 * The trusted surface: what the machinery AROUND the actors needs (delivery of hand-overs, timers, lookups for a runtime).
	 * None of it checks who is asking, because nobody asks: it is held only by code the operator wrote (the dispatch pump, the
	 * agent runtime adapter, the server's timer). Hand a transport or a tool the `Core` type and none of this is reachable.
	 */
	readonly trusted: Trusted = {
		pendingOutbox: (limit) => this.pendingOutbox(limit),
		markOutbox: (id, status, error) => this.markOutbox(id, status, error),
		bumpOutbox: (id, error) => this.bumpOutbox(id, error),
		cancelOutboxFromRun: (runId, reason) => this.cancelOutboxFromRun(runId, reason),
		workingMessages: () => this.workingMessages(),
		expireDecisions: () => this.expireDecisions(),
		findMessage: (id) => this.findMessage(id),
		messageByRequest: (requestId) => this.messageByRequest(requestId),
		messagesWithMeta: (path, value, o) => this.messagesWithMeta(path, value, o),
	};

}

// ------------------------------------------------------------------ row mappers

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
/** "agent:ops" -> "ops": the @handle people type. */
export const handleOf = (actorId: Id) => actorId.split(":").pop()!.toLowerCase();
const rowToSpace = (r: Row): Space => ({
	realmId: r.realm_id, id: r.id, kind: r.kind, name: r.name, topic: r.topic, status: r.status, ownerId: r.owner_id, agentIds: JSON.parse(r.agent_ids), createdBy: r.created_by, createdAt: r.created_at,
});
const rowToMessage = (r: Row): Message => ({
	id: r.id, realmId: r.realm_id, spaceId: r.space_id, authorId: r.author_id, authorName: r.author_name, kind: r.kind, text: r.text, meta: JSON.parse(r.meta), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

const rowToWork = (r: Row): WorkItem => ({
	realmId: r.realm_id, id: r.id, kind: r.kind, title: r.title, goal: r.goal, state: r.state, phase: r.phase,
	ownerId: r.owner_id, parentId: r.parent_id, spaceId: r.space_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});
const rowToRef = (r: Row): ExternalRef => ({
	realmId: r.realm_id, workId: r.work_id, source: r.source, externalId: r.external_id, label: r.label, url: r.url, state: r.state, observedAt: r.observed_at,
});
const rowToDecision = (r: Row): DecisionRequest => ({
	realmId: r.realm_id, id: r.id, key: r.key, workId: r.work_id, question: r.question, options: JSON.parse(r.options), context: JSON.parse(r.context),
	urgency: r.urgency, requiredAuthority: r.required_authority, requestedBy: r.requested_by, status: r.status, answer: r.answer, decidedBy: r.decided_by,
	note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at,
});
const rowToAttention = (r: Row): AttentionItem => ({
	realmId: r.realm_id, id: r.id, kind: r.kind, workId: r.work_id, subjectId: r.subject_id, summary: r.summary, createdAt: r.created_at, resolvedAt: r.resolved_at,
});
const rowToEvent = (r: Row): ActivityEvent => ({
	seq: r.seq, realmId: r.realm_id, ts: r.ts, type: r.type, actorId: r.actor_id, subjectKind: r.subject_kind, subjectId: r.subject_id, data: JSON.parse(r.data),
});
