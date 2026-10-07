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
import { inCluster, KubeSandbox } from "./adapters/sandbox/kube.ts";
import { SandboxManager } from "./adapters/sandbox/manager.ts";
import { PodmanSandbox } from "./adapters/sandbox/podman.ts";
import { sandboxEnvResolver } from "./adapters/sandbox/env.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { sandboxConfig as sbx } from "./config.ts";

const core = new Core(openDb(join(config.dataDir, "entropi.sqlite")));
seedRealm(core, config.defaultRealm);
// The runtime needs the app's live push, so the app asks for the runtime lazily.
let runtime: PiRuntime | undefined;
// Sandboxes: in the cluster a pod, on a plain machine a rootless podman container with no network. Neither is required.
let sandboxes: SandboxManager | undefined;
const kind = sbx.backend === "auto" ? (inCluster() ? "kube" : (await PodmanSandbox.available()) ? "podman" : "none") : sbx.backend;
if (kind === "kube") sandboxes = new SandboxManager({ db: core.db, backend: new KubeSandbox({ namespace: sbx.namespace }), image: sbx.image, max: sbx.max, idleMin: sbx.idleMin });
if (kind === "podman") sandboxes = new SandboxManager({ db: core.db, backend: new PodmanSandbox({ dir: join(config.dataDir, "sandboxes"), network: sbx.network }), image: sbx.image, max: sbx.max, idleMin: sbx.idleMin });
sandboxes?.startSweeper();
console.log(`sandbox: ${sandboxes ? `${kind}${kind === "podman" ? `, network ${sbx.network}` : ""}, image ${sbx.image}` : "none (agents get no sandbox tools)"}`);

const app = createApp({ core, config, control: () => runtime, sandboxes: () => sandboxes });
const live = (m: import("./core/types.ts").Message) => app.hub.live({ realmId: m.realmId, spaceId: m.spaceId, type: "message", message: m });

// Models: a local OpenAI-compatible endpoint first (works fully airgapped); cloud providers only when explicitly
// configured and AIRGAPPED is not set. With no model configured at all, scripted demo agents stand in.
const inferenceCfg = inferenceFromEnv(process.env);
const inference = buildInference(inferenceCfg);
let dispatcher;
if (inference.providers.length) {
	runtime = new PiRuntime({
		core, storage: await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite")), inference, live, images: createUploads(join(config.dataDir, "uploads")),
		// Pi's own coding tools (read, write, edit, bash); with a sandbox they run in it, without one they fail plainly.
		extensions: [CodingTools],
		env: sandboxes ? sandboxEnvResolver({ core, manager: sandboxes, locate: (id) => runtime?.locate(id) }) : undefined,
	});
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
