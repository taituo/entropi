import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { configFromEnv, type Config, type SandboxSettings } from "./config.ts";
import { Core } from "./core/core.ts";
import { openDb } from "./core/db.ts";
import type { AgentControl, AgentDispatcher, EntropiSource, SourceEvent } from "./core/ports.ts";
import type { ExternalRef, Id, Message } from "./core/types.ts";
import { PiRuntime } from "./adapters/pi/runtime.ts";
import type { ToolHost } from "./adapters/pi/tools.ts";
import { buildInference, type Inference, type InferenceConfig, type ModelRef } from "./adapters/pi/inference.ts";
import { inCluster, KubeSandbox } from "./adapters/sandbox/kube.ts";
import { SandboxManager } from "./adapters/sandbox/manager.ts";
import { PodmanSandbox } from "./adapters/sandbox/podman.ts";
import { sandboxEnvResolver } from "./adapters/sandbox/env.ts";
import { createApp, type App } from "./http/app.ts";
import { createUploads } from "./http/uploads.ts";
import { OptChat, openMemoryDb } from "./memory/optchat.ts";
import { DispatchPump } from "./runtime/pump.ts";
import { bridgeSource } from "./runtime/sources.ts";
import { seedRealm, type RealmSeed } from "./seed.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** What Entropi hands a custom agent runtime so it can speak only through the core. */
export type DispatcherContext = { core: Core; realmId: Id; dataDir: string; memory: OptChat; /** Push a streaming update of an agent message to connected clients (never logged). */ live(m: Message): void };
/** A bring-your-own agent runtime: wakes agents (required) and offers whichever of stop/compact/memtree/usage it has. */
export type Dispatcher = AgentDispatcher & AgentControl & { start?(): Promise<void>; close?(): Promise<void> };
/** An external source, optionally with what its state changes mean (policy is yours; Entropi only caches observed state on linked refs). */
export type SourceBinding = { source: EntropiSource; onChange?(e: SourceEvent, ref: ExternalRef): void | Promise<void>; onUnlinked?(e: SourceEvent): void | Promise<void> };
/** Settings of the bundled Pi Durable runtime (experimental). */
export type PiOptions = {
	inference: Inference | InferenceConfig;
	/** Tool sets beyond Entropi's own (ask_agent, request_approval, memory_zoom, consult). Agents get them by name through `profile.extensions`. */
	extensions?: Extension[] | ((host: ToolHost & { source(id: string): EntropiSource | undefined }) => Extension[]);
	summarizerModel?: ModelRef;
	viewBytes?: number;
	keepRecentTokens?: number;
	settings?: Record<string, unknown>;
};

export type EntropiOptions = {
	/** Where everything durable lives: the core's database, Pi's storage, memory, uploads, sandbox registry. */
	dataDir: string;
	/** The realm every signed-in person joins, with its agents and standing spaces, as data. Seeding is idempotent. */
	realm: RealmSeed;
	/** HTTP settings; whatever is left out is the default from `configFromEnv({})`. `realm.id` is the default realm. */
	config?: DeepPartial<Omit<Config, "dataDir" | "defaultRealm">>;
	/** The bundled agent runtime on Pi Durable. Leave it out and give `dispatcher` instead, or neither: messages then wait in the outbox. */
	pi?: PiOptions;
	/** Your own agent runtime instead of Pi. */
	dispatcher?: (ctx: DispatcherContext) => Dispatcher | Promise<Dispatcher>;
	/** External systems. Their state changes are cached on linked refs; tools reach them through `pi.extensions`' `host.source(id)`. */
	sources?: (EntropiSource | SourceBinding)[];
	/** Where agents run commands: settings (the backend is picked from them), your own manager, or false/omitted for none. */
	sandbox?: SandboxSettings | SandboxManager | false;
	/** How often decisions past their deadline are expired. Default 30 s. */
	expireEveryMs?: number;
};

export type Entropi = {
	core: Core;
	/** The HTTP+SSE transport. Not listening until you call `listen`. */
	app: App;
	/** The Pi runtime, when `pi` was given. */
	runtime?: PiRuntime;
	sandboxes?: SandboxManager;
	/** Listen on a port (0 = any free one) and resolve with the port actually used. */
	listen(port: number): Promise<number>;
	/** Stop everything this created. Idempotent. */
	close(): Promise<void>;
};

const isBinding = (s: EntropiSource | SourceBinding): s is SourceBinding => "source" in s;
const isManager = (s: SandboxSettings | SandboxManager): s is SandboxManager => typeof (s as SandboxManager).ensure === "function";
const hasModels = (i: Inference | InferenceConfig): i is Inference => "models" in i;

async function openSandboxes(dataDir: string, s: SandboxSettings | SandboxManager | false | undefined): Promise<{ manager?: SandboxManager; kind: string }> {
	if (!s) return { kind: "none" };
	if (isManager(s)) return { manager: s, kind: "custom" };
	const kind = s.backend === "auto" ? (inCluster() ? "kube" : (await PodmanSandbox.available()) ? "podman" : "none") : s.backend;
	if (kind === "none") return { kind };
	const db = new DatabaseSync(join(dataDir, "sandboxes.sqlite")); // the sandbox registry is the adapter's own: tokens and names of running containers
	const backend = kind === "kube" ? new KubeSandbox({ namespace: s.namespace }) : new PodmanSandbox({ dir: join(dataDir, "sandboxes"), network: s.network });
	return { manager: new SandboxManager({ db, backend, image: s.image, max: s.max, idleMin: s.idleMin }), kind: kind === "podman" ? `podman, network ${s.network}` : kind };
}

/**
 * Assembles a running Entropi from parts, in the one place that knows all of them: the core and its database, the HTTP app, the
 * agent runtime (Pi Durable or yours), sources, sandbox and memory. `src/server.ts` (the demo) is just a caller of this.
 * Nothing here is read from the environment: pass everything in (`configFromEnv` and friends are there if you want env vars).
 */
export async function createEntropi(o: EntropiOptions): Promise<Entropi> {
	mkdirSync(o.dataDir, { recursive: true });
	const config: Config = { ...configFromEnv({}), ...o.config, dataDir: o.dataDir, defaultRealm: o.realm.id, brand: { ...configFromEnv({}).brand, ...o.config?.brand }, auth: { ...configFromEnv({}).auth, ...o.config?.auth } } as Config;
	const core = new Core(openDb(join(o.dataDir, "entropi.sqlite")));
	seedRealm(core, o.realm);

	const { manager: sandboxes, kind } = await openSandboxes(o.dataDir, o.sandbox);
	sandboxes?.startSweeper();
	console.log(`sandbox: ${sandboxes ? `${kind}` : "none (agents get no sandbox tools)"}`);

	// The runtime needs the app's live push, and the app needs the runtime for stop/compact: each asks for the other lazily.
	let control: Dispatcher | undefined;
	const app = createApp({ core, config, control: () => control, sandboxes: () => sandboxes });
	const live = (m: Message) => app.hub.live({ realmId: m.realmId, spaceId: m.spaceId, type: "message", message: m });

	const sources = new Map<string, EntropiSource>();
	const bindings = (o.sources ?? []).map((s) => (isBinding(s) ? s : { source: s }));
	for (const b of bindings) {
		if (sources.has(b.source.id)) throw new Error(`two sources share the id "${b.source.id}"`);
		sources.set(b.source.id, b.source);
	}

	const memory = new OptChat(openMemoryDb(join(o.dataDir, "memory.sqlite")));
	let runtime: PiRuntime | undefined;
	if (o.pi && o.dispatcher) throw new Error("give either pi or dispatcher, not both");
	if (o.pi) {
		const p = o.pi;
		runtime = new PiRuntime({
			core, memory, live, storage: await openNodeSqliteStorage(join(o.dataDir, "pi.sqlite")), inference: hasModels(p.inference) ? p.inference : buildInference(p.inference),
			images: createUploads(join(o.dataDir, "uploads")), extensions: p.extensions, sources: (id) => sources.get(id),
			summarizerModel: p.summarizerModel, viewBytes: p.viewBytes, keepRecentTokens: p.keepRecentTokens, settings: p.settings,
			env: sandboxes ? sandboxEnvResolver({ core, manager: sandboxes, locate: (id) => runtime?.locate(id) }) : undefined,
		});
		await runtime.start();
		control = runtime;
	} else if (o.dispatcher) {
		control = await o.dispatcher({ core, realmId: o.realm.id, dataDir: o.dataDir, memory, live });
		await control.start?.();
	}
	const pump = control ? new DispatchPump(core, control) : undefined;
	pump?.start();

	const bridges = bindings.map((b) => bridgeSource(core, b.source, { realmId: o.realm.id, onChange: b.onChange, onUnlinked: b.onUnlinked }));
	const timer = setInterval(() => core.trusted.expireDecisions(), o.expireEveryMs ?? 30_000);
	timer.unref();

	let closed: Promise<void> | undefined;
	return {
		core, app, runtime, sandboxes,
		listen: (port) => new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(port, () => resolve((app.server.address() as { port: number }).port)); }),
		close: () => (closed ??= (async () => {
			clearInterval(timer);
			for (const b of bridges) b.stop();
			pump?.stop();
			app.close();
			sandboxes?.stopSweeper();
			await control?.close?.();
		})()),
	};
}
