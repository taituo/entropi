import { join } from "node:path";
import { config } from "./config.ts";
import { Core } from "./core/core.ts";
import { openDb } from "./core/db.ts";
import { ScriptedAgents } from "./adapters/demo/scripted.ts";
import { createApp } from "./http/app.ts";
import { seedRealm } from "./seed.ts";

const core = new Core(openDb(join(config.dataDir, "entropi.sqlite")));
seedRealm(core, config.defaultRealm);

// No model runtime yet: the scripted agents drive the same core API a real adapter will.
const agents = new ScriptedAgents(core);
const app = createApp({ core, config, dispatcher: agents });
agents.live = (m) => app.hub.live({ realmId: m.realmId, spaceId: m.spaceId, type: "message", message: m });

const timer = setInterval(() => core.expireDecisions(), 30_000);
app.server.listen(config.port, () => console.log(`${config.brand.name} listening on :${config.port} (auth=${config.auth.mode}, realm=${config.defaultRealm})`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { clearInterval(timer); app.close(); process.exit(0); });
