import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { SandboxBackend, SandboxState } from "./backend.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const PORT = 8099;
export const inCluster = () => !!process.env.KUBERNETES_SERVICE_HOST;

let ca: Buffer | undefined;
/** Minimal in-cluster Kubernetes API client. RBAC on the ServiceAccount (k8s/sandboxes.yaml) is the real boundary. */
async function kube<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
	if (!inCluster()) throw new Error("not running inside a Kubernetes cluster");
	ca ??= readFileSync(`${SA}/ca.crt`);
	const token = readFileSync(`${SA}/token`, "utf8").trim();
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise<T>((resolve, reject) => {
		const req = https.request({
			host: process.env.KUBERNETES_SERVICE_HOST, port: process.env.KUBERNETES_SERVICE_PORT ?? 443, path, method, ca, timeout: 15000,
			headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				if ((res.statusCode ?? 500) >= 300) return reject(new Error(`kubernetes ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`));
				try { resolve((text ? JSON.parse(text) : {}) as T); } catch (e) { reject(e); }
			});
		});
		req.on("timeout", () => req.destroy(new Error("kubernetes request timed out")));
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

/** The pod, with every isolation property the security model relies on (asserted by a test). */
export function podSpec(o: { name: string; key: string; token: string; image: string; namespace: string }) {
	return {
		apiVersion: "v1", kind: "Pod",
		metadata: { name: o.name, namespace: o.namespace, labels: { app: "entropi-sandbox", "entropi.io/key": createHash("sha1").update(o.key).digest("hex").slice(0, 16) }, annotations: { "entropi.io/key": o.key } },
		spec: {
			restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false, activeDeadlineSeconds: 7200,
			securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
			containers: [{
				name: "runner", image: o.image, imagePullPolicy: "IfNotPresent",
				env: [{ name: "RUNNER_TOKEN", value: o.token }, { name: "WORK_DIR", value: "/work" }],
				ports: [{ containerPort: PORT }],
				readinessProbe: { httpGet: { path: "/health", port: PORT }, periodSeconds: 1 },
				securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
				resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "1", memory: "1Gi" } },
				volumeMounts: [{ name: "work", mountPath: "/work" }, { name: "tmp", mountPath: "/tmp" }],
			}],
			volumes: [{ name: "work", emptyDir: { sizeLimit: "1Gi" } }, { name: "tmp", emptyDir: { sizeLimit: "256Mi" } }],
		},
	};
}

export class KubeSandbox implements SandboxBackend {
	readonly name = "kube";
	private ns: string;
	constructor(o: { namespace?: string } = {}) {
		this.ns = o.namespace ?? "ai-sandboxes";
	}
	async start(a: { name: string; key: string; token: string; image: string }) {
		await kube("POST", `/api/v1/namespaces/${this.ns}/pods`, podSpec({ ...a, namespace: this.ns }));
	}
	async inspect(name: string): Promise<SandboxState> {
		let pod: any;
		try { pod = await kube("GET", `/api/v1/namespaces/${this.ns}/pods/${name}`); } catch (e) {
			if (/-> 404/.test((e as Error).message)) return { state: "missing" };
			throw e;
		}
		const phase = pod.status?.phase;
		if (phase === "Failed" || phase === "Succeeded") return { state: "failed", detail: `${pod.status.reason ?? phase} ${pod.status.message ?? ""}`.trim() };
		if (phase === "Running" && pod.status.podIP && pod.status.containerStatuses?.[0]?.ready) return { state: "running", endpoint: { kind: "tcp", host: pod.status.podIP, port: PORT } };
		return { state: "starting" };
	}
	async remove(name: string) {
		await kube("DELETE", `/api/v1/namespaces/${this.ns}/pods/${name}`).catch(() => undefined);
	}
	async list() {
		const r = await kube("GET", `/api/v1/namespaces/${this.ns}/pods?labelSelector=app%3Dentropi-sandbox`).catch(() => ({ items: [] }));
		return (r.items ?? []).map((p: any) => p.metadata.name as string);
	}
}
