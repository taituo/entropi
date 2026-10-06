import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { config } from "./config.ts";
import { Core } from "./core/core.ts";
import { openDb } from "./core/db.ts";
import { ScriptedAgents } from "./adapters/demo/scripted.ts";
import { buildInference, inferenceFromEnv } from "./adapters/pi/inference.ts";
import { PiRuntime } from "./adapters/pi/runtime.ts";
import { createApp } from "./http/app.ts";
import { DispatchPump } from "./runtime/pump.ts";
import { createUploads } from "./http/uploads.ts";
import { seedRealm } from "./seed.ts";

const core = new Core(openDb(join(config.dataDir, "entropi.sqlite")));
seedRealm(core, config.defaultRealm);
// The runtime needs the app's live push, so the app asks for the runtime lazily.
let runtime: PiRuntime | undefined;
const app = createApp({ core, config, control: () => runtime });
const live = (m: import("./core/types.ts").Message) => app.hub.live({ realmId: m.realmId, spaceId: m.spaceId, type: "message", message: m });

// Models: a local OpenAI-compatible endpoint first (works fully airgapped); cloud providers only when explicitly
// configured and AIRGAPPED is not set. With no model configured at all, scripted demo agents stand in.
const inferenceCfg = inferenceFromEnv(process.env);
const inference = buildInference(inferenceCfg);
let dispatcher;
if (inference.providers.length) {
	runtime = new PiRuntime({ core, storage: await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite")), inference, live, images: createUploads(join(config.dataDir, "uploads")) });
	await runtime.start();
	dispatcher = runtime;
	console.log(`agents: Pi Durable, providers=${inference.providers.join(",")}${inferenceCfg.airgapped ? " (airgapped)" : ""}`);
} else {
	const demo = new ScriptedAgents(core);
	demo.live = live;
	dispatcher = demo;
	console.log("agents: scripted demo (no model configured; set LOCAL_LLM_BASE_URL and LOCAL_LLM_MODEL)");
}
const pump = new DispatchPump(core, dispatcher);
pump.start();

const timer = setInterval(() => core.expireDecisions(), 30_000);
app.server.listen(config.port, () => console.log(`${config.brand.name} listening on :${config.port} (auth=${config.auth.mode}, realm=${config.defaultRealm})`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { clearInterval(timer); pump.stop(); app.close(); await runtime?.close(); process.exit(0); });
