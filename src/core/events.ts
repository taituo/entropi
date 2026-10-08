/**
 * Every event type, in one place. The log is append-only and other programs read it (SSE, `core.eventsSince`, subscribers), so
 * a type is a public name: new ones are a minor release, renaming or removing one is a major release. A test guards this list
 * against the code that emits them.
 */
export const CORE_EVENT_TYPES = [
	"realm.created",
	"actor.joined", "actor.updated", "presence.changed",
	"work.created", "work.state", "ref.linked", "ref.observed",
	"decision.requested", "decision.decided", "decision.cancelled", "decision.expired",
	"space.created", "space.archived", "space.reopened",
	"message.posted", "message.updated", "message.completed",
	"delegation.requested",
	"attention.raised", "attention.resolved",
] as const;
export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];

/** Facts the bundled adapters and the HTTP layer put on the record through `core.record`. An integration may record its own types the same way (namespace them: "myapp.thing"). */
export const BUNDLED_EVENT_TYPES = ["agent.stopped", "agent.compacted", "sandbox.exec", "sandbox.stopped", "k8s.apply", "memory.noted"] as const;
export type BundledEventType = (typeof BUNDLED_EVENT_TYPES)[number];

export const EVENT_TYPES = [...CORE_EVENT_TYPES, ...BUNDLED_EVENT_TYPES] as const;
export type EventType = CoreEventType | BundledEventType;
