// The demo server: one caller of createEntropi, configured from environment variables. A project that builds on Entropi writes
// its own version of this file with its own realm, agents, sources and tools.
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { config, sandboxConfig } from "./config.ts";
import { createEntropi } from "./entropi.ts";
import { inferenceFromEnv, buildInference } from "./adapters/pi/inference.ts";
import { k8sExtension } from "./adapters/pi/k8s-tools.ts";
import { FakeWorld } from "./adapters/fake-world/world.ts";
import { ScriptedAgents } from "./adapters/demo/scripted.ts";
import { demoRealm } from "./demo/realm.ts";

// Models: a local OpenAI-compatible endpoint first (works fully airgapped); cloud providers only when explicitly
// configured and AIRGAPPED is not set. With no model configured at all, scripted demo agents stand in.
const inferenceCfg = inferenceFromEnv(process.env);
const inference = buildInference(inferenceCfg);

const entropi = await createEntropi({
	dataDir: config.dataDir,
	realm: demoRealm(config.defaultRealm),
	config,
	sandbox: sandboxConfig,
	// The demo source: a fake cluster behind the EntropiSource port. A real cluster adapter would take its place here.
	sources: [new FakeWorld()],
	...(inference.providers.length
		? { pi: {
			inference,
			// Pi's own coding tools (read, write, edit, bash) run in the sandbox when there is one; without one they fail plainly.
			extensions: (host) => [CodingTools, k8sExtension({ ...host, source: () => host.source("k8s"), readNamespaces: ["demo-apps"], writeNamespaces: ["demo-apps"] })],
		} }
		: { dispatcher: ({ core, live }) => Object.assign(new ScriptedAgents(core), { live }) }),
});
console.log(entropi.runtime
	? `agents: Pi Durable, providers=${inference.providers.join(",")}${inferenceCfg.airgapped ? " (airgapped)" : ""}`
	: "agents: scripted demo (no model configured; set LOCAL_LLM_BASE_URL and LOCAL_LLM_MODEL)");

await entropi.listen(config.port);
console.log(`${config.brand.name} listening on :${config.port} (auth=${config.auth.mode}, realm=${config.defaultRealm})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await entropi.close(); process.exit(0); });
