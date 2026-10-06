import type { Core } from "./core/core.ts";

type AgentSeed = { id: string; name: string; title: string; color: string; can: string[]; cannot: string[]; spaces: string[] };
export const AGENTS: AgentSeed[] = [
	{ id: "agent:ops", name: "Ops", title: "SRE agent", color: "#16a34a", spaces: ["general", "production", "insights", "incidents"],
		can: ["Read pods, events, logs, configmaps", "Apply reviewed config from the repo (needs human approval)", "Restart deployments (needs human approval)"],
		cannot: ["Write outside its namespace", "Read secrets", "Change code"] },
	{ id: "agent:developer", name: "Developer", title: "Software engineer agent", color: "#2563eb", spaces: ["general", "development", "incidents"],
		can: ["Read the config repository", "Create branches and commit changes", "Run checks in an isolated sandbox"],
		cannot: ["Touch the cluster", "Merge to main", "Read secrets"] },
	{ id: "agent:reviewer", name: "Reviewer", title: "Code review agent", color: "#d97706", spaces: ["general", "development", "incidents"],
		can: ["Read branch diffs", "Run the checks on a branch", "Approve or reject changes in chat"],
		cannot: ["Write files", "Touch the cluster"] },
	{ id: "agent:insight", name: "Insight", title: "Analyst agent", color: "#db2777", spaces: ["general", "insights", "incidents"],
		can: ["Query tickets, changes, builds and workflows (read only)", "Draw charts and tables"],
		cannot: ["Change code or infrastructure", "Approve anything"] },
];
const SPACES = [
	{ id: "general", topic: "Everyone: people and agents" },
	{ id: "development", topic: "Code changes and reviews" },
	{ id: "production", topic: "Live systems and alerts" },
	{ id: "insights", topic: "Ask about builds, workflows and metrics" },
	{ id: "incidents", topic: "Self-healing and incident response" },
];

/** A fresh realm with the demo cast. Idempotent: running it again changes nothing. */
export function seedRealm(core: Core, realmId: string, name = "Demo Company") {
	core.createRealm({ id: realmId, name, kind: "team" });
	for (const a of AGENTS) core.addActor(realmId, { id: a.id, kind: "agent", name: a.name, profile: { title: a.title, color: a.color, can: a.can, cannot: a.cannot } });
	for (const s of SPACES) {
		const agentIds = AGENTS.filter((a) => a.spaces.includes(s.id)).map((a) => a.id);
		const { created } = core.createSpace(realmId, { id: s.id, kind: "standing", name: s.id, topic: s.topic, agentIds }, "system");
		if (created) core.postMessage(realmId, s.id, "system", { kind: "notice", text: `Welcome to #${s.id} — ${s.topic}. Agents here: ${agentIds.map((i) => `@${i.split(":")[1]}`).join(", ")}. Mention one to give it work.` });
	}
}
