/**
 * Entropi core domain. Eight objects, nothing integration-specific: no runtime, workflow engine, review system or UI.
 * Every object carries a realm id from day one; a realm is a context + authority + attention boundary.
 */
export type Id = string;

export type RealmKind = "personal" | "team" | "product" | "org" | "incident" | "autonomous";
export type RealmPolicy = {
	/** A decision cannot be decided by the actor that requested it. */
	separationOfDuties: boolean;
	/** How freely agents may act in this realm without a human decision. */
	autonomy: "low" | "medium" | "high";
	/** How many agent-to-agent hops one human message may cause. */
	maxDelegationDepth: number;
	/** Agent-initiated delegations allowed per space per 10 minutes. */
	delegationsPer10Min: number;
};
export type Realm = { id: Id; name: string; kind: RealmKind; policy: RealmPolicy; createdAt: number };

export type ActorKind = "human" | "agent" | "system";
/** Immutable identity (id) plus a display-name snapshot. Roles are per realm: the same actor may differ between realms. */
export type Actor = { realmId: Id; id: Id; kind: ActorKind; name: string; roles: string[]; createdAt: number };

export type PresenceState = "active" | "away" | "silent" | "idle" | "working" | "waiting" | "error" | "offline";
/** `echo`: a human is away and a delegate may answer questions about them, but never contribute, vote or approve. */
export type Presence = { realmId: Id; actorId: Id; state: PresenceState; echo: boolean; updatedAt: number };

export type WorkState = "queued" | "working" | "waiting" | "blocked" | "failed" | "done" | "cancelled";
/** Long-lived goal. Not an LLM run, not a chat: runs and conversations hang off it through ExternalRefs. */
export type WorkItem = {
	realmId: Id;
	id: Id;
	kind: string;
	title: string;
	goal: string;
	state: WorkState;
	/** Free-form stage within the state ("triage", "implement", "review"...). Adapters map their own vocabulary onto it. */
	phase: string | null;
	/** Space where this work is discussed; its decisions appear there as cards. */
	spaceId: Id | null;
	ownerId: Id | null;
	parentId: Id | null;
	createdAt: number;
	updatedAt: number;
};

/** Pointer into a system that owns the operational truth (workflow, change, build, session). Entropi keeps references and cached state only. */
export type ExternalRef = {
	realmId: Id;
	workId: Id;
	source: string;
	externalId: string;
	label: string | null;
	url: string | null;
	/** Last state observed from the source; the source stays authoritative. */
	state: string | null;
	observedAt: number | null;
};

export type DecisionStatus = "open" | "decided" | "cancelled" | "expired";
/** A structured question a human has to answer. The only way a system asks a person for something. */
export type DecisionRequest = {
	realmId: Id;
	id: Id;
	/** Idempotency key chosen by the requester: asking twice with the same key yields the same request. */
	key: string;
	workId: Id;
	question: string;
	options: string[];
	context: Record<string, unknown>;
	urgency: "low" | "normal" | "high";
	/** Role an actor needs to decide it. */
	requiredAuthority: string;
	requestedBy: Id;
	status: DecisionStatus;
	answer: string | null;
	decidedBy: Id | null;
	note: string | null;
	createdAt: number;
	expiresAt: number | null;
	decidedAt: number | null;
};

export type AttentionKind = "decision" | "failure" | "blocked";
/** What deserves a human's thought right now. Derived by the core from state changes, never written by clients. */
export type AttentionItem = {
	realmId: Id;
	id: Id;
	kind: AttentionKind;
	workId: Id;
	/** decision id for kind=decision, otherwise the work id. */
	subjectId: Id;
	summary: string;
	createdAt: number;
	resolvedAt: number | null;
};

/** Append-only fact. The log says what happened; projection tables say what is true now. Both change in one transaction. */
export type ActivityEvent = {
	seq: number;
	realmId: Id;
	ts: number;
	type: string;
	actorId: Id;
	subjectKind: string;
	subjectId: Id;
	data: Record<string, unknown>;
};

/** What a person sees: the smallest set of things worth their thought. */
export type Focus = {
	realmId: Id;
	needsYou: { decision: DecisionRequest; attention: AttentionItem }[];
	attention: AttentionItem[];
	working: WorkItem[];
	waiting: WorkItem[];
	background: { count: number };
};

export type SpaceKind = "standing" | "case" | "dm";
/** A place where people and agents talk. Standing rooms are permanent, cases end, DMs belong to exactly one person. */
export type Space = {
	realmId: Id;
	id: Id;
	kind: SpaceKind;
	name: string;
	topic: string;
	status: "open" | "archived";
	/** dm only: the one human who can see it. Nobody else, admins included. */
	ownerId: Id | null;
	/** Agents present. Only these can be addressed or post here. */
	agentIds: Id[];
	createdBy: Id;
	createdAt: number;
};

export type MessageKind = "chat" | "notice" | "case" | "decision" | "agent";
export type Message = {
	id: number;
	realmId: Id;
	spaceId: Id;
	authorId: Id;
	/** Display-name snapshot; identity is authorId. */
	authorName: string;
	kind: MessageKind;
	text: string;
	meta: Record<string, unknown>;
	/** "working" while an agent is still writing it. */
	status: "working" | "done";
	createdAt: number;
	updatedAt: number;
};
