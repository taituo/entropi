import type { EntropiSource, InvokeContext, SourceEvent } from "../../core/ports.ts";

/**
 * A small, deterministic fake cluster for demos and tests (Crewpi's demo story, without needing a cluster): in the namespace
 * demo-apps, `checkout-api` crash-loops because its ConfigMap has POOL_SIZE=0. Applying a sane value and restarting the
 * deployment heals it. It is an EntropiSource like any real one would be: state changes come out of `observe`, reads go
 * through `query`, changes go through `invoke`. It is demo data and never part of the core.
 */
const MIN = 60_000;
/** `env` is the ConfigMap data the running pods started with: a change reaches them only when the deployment restarts, as in Kubernetes. */
type Deployment = { name: string; image: string; replicas: number; configMaps: string[]; env: Record<string, string>; restartedAt: string | null; rolloutAt: number };
type ConfigMap = { name: string; data: Record<string, string> };

export class FakeWorld implements EntropiSource {
	readonly id = "k8s";
	now: () => number;
	private startedAt: number;
	private ns = "demo-apps";
	private configMaps = new Map<string, ConfigMap>();
	private deployments = new Map<string, Deployment>();
	private lastState = new Map<string, string>();
	private queue: SourceEvent[] = [];
	private wake?: () => void;
	/** Results by idempotency key: a repeated key returns the first result and executes nothing. */
	private done = new Map<string, unknown>();
	/** How many effects actually ran (not counting repeats), for tests. */
	executed = 0;
	private restarts = 0;

	constructor(o: { now?: () => number } = {}) {
		this.now = o.now ?? Date.now;
		this.startedAt = this.now() - 42 * MIN; // the incident began a while ago
		this.reset();
	}

	/** Back to the broken starting point. */
	reset() {
		this.startedAt = this.now() - 42 * MIN;
		this.configMaps = new Map<string, ConfigMap>([
			["checkout-config", { name: "checkout-config", data: { POOL_SIZE: "0", REGION: "eu-north-1", FEATURE_NEW_CART: "true" } }],
			["orders-config", { name: "orders-config", data: { WORKERS: "4", REGION: "eu-north-1" } }],
		]);
		this.deployments = new Map<string, Deployment>([
			["checkout-api", { name: "checkout-api", image: "docker.io/library/busybox:1.37", replicas: 1, configMaps: ["checkout-config"], env: { POOL_SIZE: "0", REGION: "eu-north-1", FEATURE_NEW_CART: "true" }, restartedAt: null, rolloutAt: this.startedAt }],
			["orders-api", { name: "orders-api", image: "docker.io/library/busybox:1.37", replicas: 2, configMaps: ["orders-config"], env: { WORKERS: "4", REGION: "eu-north-1" }, restartedAt: null, rolloutAt: this.startedAt - 600 * MIN }],
		]);
		this.lastState.clear();
		this.done.clear();
		for (const d of this.deployments.keys()) this.publish(d);
	}

	// ---------------------------------------------------------------- derived state

	private poolSize = (d: Deployment) => Number(d.env.POOL_SIZE ?? 1);
	private healthy = (d: Deployment) => !d.configMaps.includes("checkout-config") || this.poolSize(d) > 0;
	private stateOf = (d: Deployment) => (this.healthy(d) ? "healthy" : "unhealthy");

	private podsOf(d: Deployment) {
		const since = Math.max(0, this.now() - d.rolloutAt);
		const hash = (d.restartedAt ? Buffer.from(d.restartedAt).toString("hex").slice(-4) : "74bd") + d.name.length;
		return Array.from({ length: d.replicas }, (_, i) => ({
			name: `${d.name}-${hash}-${["x7k2p", "m9q4t", "c3v8z"][i]}`,
			ready: this.healthy(d), phase: this.healthy(d) ? "Running" : "Running",
			restarts: this.healthy(d) ? 0 : 3 + Math.floor(since / (5 * MIN)),
			state: this.healthy(d) ? "running" : "waiting:CrashLoopBackOff",
			ageMs: since,
		}));
	}

	private logsOf(d: Deployment, previous: boolean, tail: number) {
		const cm = d.env;
		const start = `${d.name} starting (region=${cm.REGION}, new_cart=${cm.FEATURE_NEW_CART ?? "false"})`;
		if (!this.healthy(d)) return previous
			? [start, `FATAL: database pool size must be > 0 (POOL_SIZE=${cm.POOL_SIZE})`]
			: ["Error from server (BadRequest): container \"api\" in pod is waiting to start: CrashLoopBackOff"];
		return [start, `database pool ready: ${cm.POOL_SIZE ?? "n/a"} connections`, "listening on :8080", "ok 12:00:30", "ok 12:01:00"].slice(-tail);
	}

	private eventsOf(d: Deployment) {
		if (this.healthy(d)) return [{ ageMs: 2 * MIN, type: "Normal", reason: "Started", object: `Pod/${d.name}`, count: 1, message: "Started container api" }];
		return [
			{ ageMs: 40 * MIN, type: "Normal", reason: "Pulled", object: `Pod/${d.name}`, count: 1, message: `Container image "${d.image}" already present on machine` },
			{ ageMs: 10 * MIN, type: "Warning", reason: "BackOff", object: `Pod/${d.name}`, count: 9, message: "Back-off restarting failed container api" },
		];
	}

	// ---------------------------------------------------------------- EntropiSource

	async query(externalId: string, args: Record<string, unknown> = {}) {
		const [kind, ns, name] = externalId.split("/");
		if (ns !== this.ns) throw new Error(`no such namespace "${ns}"`);
		const ds = [...this.deployments.values()];
		switch (kind) {
			case "pods": return { state: "ok", data: ds.flatMap((d) => this.podsOf(d).map((p) => ({ ...p, deployment: d.name }))) };
			case "events": return { state: "ok", data: ds.flatMap((d) => this.eventsOf(d)).filter((e) => !name || e.object.includes(name)) };
			case "deployments": return { state: "ok", data: ds.map((d) => ({ name: d.name, ready: this.healthy(d) ? d.replicas : 0, replicas: d.replicas, image: d.image, configMaps: d.configMaps })) };
			case "configmap": { const c = this.configMaps.get(name); if (!c) throw new Error(`configmap "${name}" not found`); return { state: "ok", data: c.data }; }
			case "logs": {
				const d = ds.find((x) => name.startsWith(x.name + "-"));
				if (!d) throw new Error(`pod "${name}" not found`);
				const lines = this.logsOf(d, !!args.previous, Math.min(Math.max(Number(args.tail ?? 60), 1), 300));
				return { state: "ok", data: { lines, fellBack: !!args.previous && this.healthy(d) } };
			}
			case "deployment": { const d = this.deployments.get(name); if (!d) throw new Error(`deployment "${name}" not found`); return { state: this.stateOf(d), data: { ...d } }; }
			default: throw new Error(`unknown object "${externalId}"`);
		}
	}

	async invoke(action: string, input: any, ctx: InvokeContext) {
		if (!ctx?.idempotencyKey) throw new Error("invoke needs an idempotency key");
		const key = `${action}:${ctx.idempotencyKey}`;
		if (this.done.has(key)) return this.done.get(key);
		const result = this.run(action, input);
		this.done.set(key, result);
		this.executed++;
		return result;
	}

	private run(action: string, input: any) {
		if (input?.namespace !== this.ns) throw new Error(`no such namespace "${input?.namespace}"`);
		if (action === "apply-configmap") {
			const c = this.configMaps.get(input.name);
			if (!c) throw new Error(`configmap "${input.name}" not found`);
			const changed = Object.entries(input.data as Record<string, string>).filter(([k, v]) => c.data[k] !== v).map(([k, v]) => ({ key: k, from: c.data[k] ?? null, to: v }));
			Object.assign(c.data, input.data);
			return { changed };
		}
		if (action === "restart-deployment") {
			const d = this.deployments.get(input.name);
			if (!d) throw new Error(`deployment "${input.name}" not found`);
			d.restartedAt = `r${++this.restarts}`; d.rolloutAt = this.now(); d.env = Object.assign({}, ...d.configMaps.map((c) => this.configMaps.get(c)?.data));
			this.publish(d.name);
			return { restarted: d.name };
		}
		throw new Error(`unknown action "${action}"`);
	}

	/** Emit a state change for a deployment if its state differs from what was last announced. */
	private publish(name: string) {
		const d = this.deployments.get(name)!;
		const state = this.stateOf(d);
		if (this.lastState.get(name) === state) return;
		this.lastState.set(name, state);
		this.queue.push({ workRef: { source: this.id, externalId: `deployment/${this.ns}/${name}` }, state, at: this.now(), data: { namespace: this.ns, name, ready: this.healthy(d) } });
		this.wake?.();
	}

	async *observe(signal: AbortSignal): AsyncIterable<SourceEvent> {
		while (!signal.aborted) {
			while (this.queue.length) yield this.queue.shift()!;
			await new Promise<void>((resolve) => { this.wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
		}
	}
}
