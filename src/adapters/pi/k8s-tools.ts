import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { EntropiSource } from "../../core/ports.ts";
import { askApproval, type ToolHost } from "./tools.ts";

const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n... [truncated ${s.length - n} chars]` : s);
const text = (t: string) => ({ content: [{ type: "text" as const, text: clip(t) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });
const age = (ms?: number) => {
	if (ms === undefined) return "?";
	const s = Math.max(0, ms / 1000);
	return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const ns = Type.String({ description: "Kubernetes namespace" });
const k8sName = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * Crewpi's k8s tools (read the cluster; change a ConfigMap only after a human approved), ported onto the EntropiSource port:
 * they know nothing about where the cluster comes from. A fake demo world and a real cluster adapter are interchangeable.
 * Namespace allow-lists are the first fence; the source's own credentials (RBAC) are the real one.
 */
export function k8sExtension(host: ToolHost & { source(): EntropiSource | undefined; readNamespaces: string[]; writeNamespaces: string[] }) {
	const src = () => {
		const s = host.source();
		if (!s?.query) throw new Error("no cluster is connected to this workspace");
		return s as EntropiSource & Required<Pick<EntropiSource, "query">>;
	};
	const readable = (n: string) => { if (!host.readNamespaces.includes(n)) throw new Error(`namespace "${n}" is not readable by agents (allowed: ${host.readNamespaces.join(", ")})`); };
	const writable = (n: string) => { if (!host.writeNamespaces.includes(n)) throw new Error(`namespace "${n}" is not writable by agents (allowed: ${host.writeNamespaces.join(", ")})`); };
	const name = (kind: string, v: string) => { if (!k8sName.test(v) || v.length > 253) throw new Error(`invalid ${kind} name: ${v}`); };

	const pods = defineTool({
		name: "k8s_pods", description: "List pods in a namespace with phase, readiness, restarts and container state (waiting reason, last exit).",
		parameters: Type.Object({ namespace: ns }), replay: "safe",
		execute: async ({ namespace }) => {
			try {
				readable(namespace);
				const { data } = await src().query(`pods/${namespace}`);
				const lines = (data as any[]).map((p) => `${p.name}  ${p.ready ? "1/1" : "0/1"}  ${p.phase}  restarts=${p.restarts}  ${p.state}  age=${age(p.ageMs)}`);
				return text(lines.join("\n") || `no pods in ${namespace}`);
			} catch (e) { return fail(e); }
		},
	});
	const events = defineTool({
		name: "k8s_events", description: "Recent events in a namespace, optionally only those about one object name.",
		parameters: Type.Object({ namespace: ns, object: Type.Optional(Type.String({ description: "Object name filter (substring)" })) }), replay: "safe",
		execute: async ({ namespace, object }) => {
			try {
				readable(namespace);
				const { data } = await src().query(`events/${namespace}${object ? `/${object}` : ""}`);
				const lines = (data as any[]).slice(-25).map((e) => `${age(e.ageMs)} ago  ${e.type}  ${e.reason}  ${e.object}  x${e.count ?? 1}  ${e.message}`);
				return text(lines.join("\n") || "no matching events");
			} catch (e) { return fail(e); }
		},
	});
	const logs = defineTool({
		name: "k8s_logs", description: "Tail of a pod's container log. Use previous=true to read the log of the last crashed container instance.",
		parameters: Type.Object({ namespace: ns, pod: Type.String(), previous: Type.Optional(Type.Boolean()), tail: Type.Optional(Type.Number({ description: "Lines, default 60, max 300" })) }), replay: "safe",
		execute: async ({ namespace, pod, previous, tail }) => {
			try {
				readable(namespace); name("pod", pod);
				const { data } = await src().query(`logs/${namespace}/${pod}`, { previous: !!previous, tail });
				const body = (data.lines as string[]).join("\n").trim() || "(empty log)";
				return text(data.fellBack ? `(previous container log not available; showing the current container)\n${body}` : body);
			} catch (e) { return fail(e); }
		},
	});
	const configMap = defineTool({
		name: "k8s_configmap", description: "Show a ConfigMap's data.", parameters: Type.Object({ namespace: ns, name: Type.String() }), replay: "safe",
		execute: async ({ namespace, name: n }) => {
			try {
				readable(namespace); name("configmap", n);
				const { data } = await src().query(`configmap/${namespace}/${n}`);
				return text(Object.entries(data).map(([k, v]) => `${k}=${v}`).join("\n") || "(no data)");
			} catch (e) { return fail(e); }
		},
	});
	const deployments = defineTool({
		name: "k8s_deployments", description: "List deployments with replica status and the ConfigMaps they use.", parameters: Type.Object({ namespace: ns }), replay: "safe",
		execute: async ({ namespace }) => {
			try {
				readable(namespace);
				const { data } = await src().query(`deployments/${namespace}`);
				return text((data as any[]).map((d) => `${d.name}  ready=${d.ready}/${d.replicas}  image=${d.image}  configmaps=${d.configMaps.join(",") || "-"}`).join("\n") || `no deployments in ${namespace}`);
			} catch (e) { return fail(e); }
		},
	});
	const apply = defineTool({
		name: "k8s_apply_configmap",
		description: "Change values of a ConfigMap, optionally restarting a deployment afterwards so it picks them up. A human must approve; the approval card shows the exact before/after values. Asks the approval itself: do not call request_approval first. Blocks until decided.",
		parameters: Type.Object({
			namespace: ns, name: Type.String({ description: "ConfigMap name" }),
			data: Type.Record(Type.String(), Type.String(), { description: "Keys to set, e.g. { \"POOL_SIZE\": \"10\" }" }),
			restart: Type.Optional(Type.String({ description: "Deployment to restart after applying" })),
			reason: Type.String({ description: "Why, with the evidence you saw" }),
		}),
		replay: "safe", // approval is keyed by the task id and every effect carries an idempotency key from the decision id: a rerun after a crash cannot apply twice
		execute: async (args, api, context) => {
			try {
				writable(args.namespace); name("configmap", args.name); if (args.restart) name("deployment", args.restart);
				const s = src();
				if (!s.invoke) throw new Error("this cluster connection is read-only");
				const live = (await s.query(`configmap/${args.namespace}/${args.name}`)).data as Record<string, string>;
				const changes = Object.entries(args.data).filter(([k, v]) => live[k] !== v).map(([k, v]) => ({ key: k, from: live[k] ?? null, to: v }));
				if (!changes.length) return text("The live ConfigMap already has these values; nothing to apply.");
				const v = await askApproval(host, api, context, {
					action: `Apply ${args.namespace}/${args.name}${args.restart ? ` and restart ${args.restart}` : ""}`,
					details: { target: `${args.namespace}/${args.name}`, restart: args.restart ?? null, reason: args.reason, changes },
				});
				if (!v.approved) return text(v.text);
				// The decision id is the same on every rerun of this task, so a replay after a crash repeats the keys and the source does nothing twice.
				const key = `decision:${v.decision.id}`;
				await s.invoke("apply-configmap", { namespace: args.namespace, name: args.name, data: args.data }, { idempotencyKey: `${key}:apply` });
				let restarted = "";
				if (args.restart) {
					await s.invoke("restart-deployment", { namespace: args.namespace, name: args.restart }, { idempotencyKey: `${key}:restart` });
					restarted = ` Restarted deployment ${args.restart}.`;
				}
				const loc = host.locate(api.conversationId);
				if (loc) host.core.record(loc.realmId, loc.agentId, "k8s.apply", "space", loc.spaceId, { spaceId: loc.spaceId, target: `${args.namespace}/${args.name}`, changes, approvedBy: v.by });
				return text(`${v.text} Applied ${args.namespace}/${args.name}: ${changes.map((c) => `${c.key} ${c.from} -> ${c.to}`).join(", ")}.${restarted} Verify with k8s_pods.`);
			} catch (e) { return fail(e); }
		},
	});
	return defineExtension({ name: "k8s", tools: [pods, events, logs, configMap, deployments, apply] });
}
