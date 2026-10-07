// Entropi's public entry: assemble a running system with createEntropi, and the types, ports and event names it speaks.
// Batteries (Pi runtime helpers, sandbox, demo fakes) are in "entropi/batteries"; the bare core without any of them is "entropi/core".
import { readFileSync } from "node:fs";
export * from "./core/index.ts";
export { createEntropi } from "./entropi.ts";
export type { Dispatcher, DispatcherContext, Entropi, EntropiOptions, PiOptions, RouterOptions, SourceBinding } from "./entropi.ts";
export { seedRealm } from "./seed.ts";
export type { AgentSeed, RealmSeed, SpaceSeed } from "./seed.ts";
/** The version of this package (semver). */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
