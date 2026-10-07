import type { Core } from "./core/core.ts";
import type { RealmKind } from "./core/types.ts";

/**
 * An agent as data. `id` (like "agent:ops"), `name` and `spaces` (where it is present) place it; everything else is its profile,
 * kept as it is and shown by clients (title, color, can, cannot) or read by the runtime (instructions, extensions = tool sets by name).
 */
export type AgentSeed = { id: string; name: string; spaces?: string[]; instructions?: string; extensions?: string[]; [profile: string]: unknown };
export type SpaceSeed = { id: string; topic?: string; /** Post a welcome notice when the space is first created (default true). */ welcome?: boolean };
/** A realm with its agents and standing spaces, given as data. */
export type RealmSeed = { id: string; name?: string; kind?: RealmKind; agents: AgentSeed[]; spaces: SpaceSeed[] };

/** Create the realm, its agents and spaces. Idempotent: running it again changes nothing. */
export function seedRealm(core: Core, seed: RealmSeed) {
	const { id: realmId } = seed;
	core.createRealm({ id: realmId, name: seed.name ?? realmId, kind: seed.kind ?? "team" });
	for (const { id, name, spaces: _, ...profile } of seed.agents) core.addActor(realmId, { id, kind: "agent", name, profile }, "system");
	for (const s of seed.spaces) {
		const agentIds = seed.agents.filter((a) => a.spaces?.includes(s.id)).map((a) => a.id);
		const { created } = core.createSpace(realmId, { id: s.id, kind: "standing", name: s.id, topic: s.topic ?? "", agentIds }, "system");
		if (created && s.welcome !== false) core.postMessage(realmId, s.id, "system", { kind: "notice", text: `Welcome to #${s.id}${s.topic ? ` — ${s.topic}` : ""}.${agentIds.length ? ` Agents here: ${agentIds.map((i) => `@${i.split(":")[1]}`).join(", ")}. Mention one to give it work.` : ""}` });
	}
}
