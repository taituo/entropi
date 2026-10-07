import { request } from "node:http";

/**
 * Where a sandbox runs. A sandbox is a small, short-lived, locked-down container that holds the files and commands an
 * agent works with; it is never the host. Backends differ only in how the container is created and reached:
 *   - podman:  on this machine, rootless, by default with NO network at all (fully airgapped), reached over a unix socket
 *   - kube:    a pod in the cluster, with NetworkPolicies and RBAC (see k8s/sandboxes.yaml), reached over the pod network
 */
export type Endpoint = { kind: "tcp"; host: string; port: number } | { kind: "unix"; socketPath: string };
export type SandboxState = { state: "running" | "starting" | "failed" | "missing"; endpoint?: Endpoint; detail?: string };

export interface SandboxBackend {
	readonly name: string;
	/** Create the sandbox if it does not exist. Idempotent per name. */
	start(o: { name: string; key: string; token: string; image: string }): Promise<void>;
	inspect(name: string): Promise<SandboxState>;
	remove(name: string): Promise<void>;
	/** Names of every sandbox this backend owns (including ones nobody tracks any more). */
	list(): Promise<string[]>;
}

/** One call to the runner inside a sandbox, over TCP or a unix socket. */
export function callRunner<T = any>(ep: Endpoint, token: string, method: "GET" | "POST" | "PUT", path: string, body?: string | object, timeoutMs = 20_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
		const req = request({
			...(ep.kind === "unix" ? { socketPath: ep.socketPath } : { host: ep.host, port: ep.port }),
			path, method, timeout: timeoutMs,
			headers: { authorization: `Bearer ${token}`, ...(typeof body === "object" ? { "content-type": "application/json" } : {}), ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) },
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				let data: any = {};
				try { data = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* not JSON */ }
				if ((res.statusCode ?? 500) >= 300) return reject(Object.assign(new Error(data.error ?? `runner HTTP ${res.statusCode}`), { status: res.statusCode }));
				resolve(data as T);
			});
		});
		req.on("timeout", () => req.destroy(new Error("sandbox request timed out")));
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}
