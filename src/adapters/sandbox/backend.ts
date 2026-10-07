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

/**
 * One call to the runner inside a sandbox, over TCP or a unix socket. The answer is a stream of JSON lines (command output
 * as it happens, then the result) or a single JSON object; `onLine` sees each, the promise resolves with the last.
 */
export function callRunner<T = any>(ep: Endpoint, token: string, path: string, body?: object, o: { onLine?: (line: any) => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = request({
			...(ep.kind === "unix" ? { socketPath: ep.socketPath } : { host: ep.host, port: ep.port }), path, method: payload ? "POST" : "GET", signal: o.signal, timeout: o.timeoutMs ?? 30_000,
			headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
		}, (res) => {
			let buf = "", last: any;
			const line = (l: string) => { if (l.trim()) { last = JSON.parse(l); o.onLine?.(last); } };
			res.setEncoding("utf8");
			res.on("data", (c: string) => { buf += c; for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
			res.on("error", reject);
			res.on("end", () => {
				try { line(buf); } catch { /* not JSON */ }
				if ((res.statusCode ?? 500) >= 300) return reject(Object.assign(new Error(last?.error ?? `runner HTTP ${res.statusCode}`), { status: res.statusCode }));
				resolve(last as T);
			});
		});
		req.on("timeout", () => req.destroy(new Error("sandbox request timed out")));
		req.on("error", reject);
		req.end(payload);
	});
}
