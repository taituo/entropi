// The core's public face: the domain, its types, its ports and its event names. Imports nothing but itself (a test guards that).
export { Core, SYSTEM, handleOf, hasRole } from "./core.ts";
export type { Listener, Trusted } from "./core.ts";
export { openDb } from "./db.ts";
export { CoreError, conflict, forbidden, invalid, notFound } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";
export { BUNDLED_EVENT_TYPES, CORE_EVENT_TYPES, EVENT_TYPES } from "./events.ts";
export type { BundledEventType, CoreEventType, EventType } from "./events.ts";
export { CAPABILITIES } from "./ports.ts";
export type { AgentControl, AgentDispatcher, EntropiSource, InvokeContext, SourceEvent, TranscriptEntry, TranscriptSource } from "./ports.ts";
export type * from "./types.ts";
