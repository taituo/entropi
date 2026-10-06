import type { Core } from "../../core/core.ts";
import { handleOf } from "../../core/core.ts";
import type { AgentDispatcher } from "../../core/ports.ts";
import type { Id, Message } from "../../core/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Step = { id: string; name: string; args: string; status: "running" | "done" | "error"; preview?: string };

/**
 * A scripted stand-in for the agent runtime, so the whole loop (message -> agent work -> approval card -> verdict ->
 * follow-up) runs without a model. It speaks only through the core, exactly like a real adapter has to.
 */
export class ScriptedAgents implements AgentDispatcher {
	readonly core: Core;
	/** Called with every streaming update of an agent message (the HTTP layer pushes it live). */
	live: (m: Message) => void = () => {};
	stepMs: number;
	private waiting = new Map<Id, { realmId: Id; spaceId: Id; agentId: Id; target: string }>();

	constructor(core: Core, o: { stepMs?: number } = {}) {
		this.core = core;
		this.stepMs = o.stepMs ?? 600;
		core.subscribe((e) => {
			if (e.type !== "decision.decided") return;
			const w = this.waiting.get(String(e.data.workId));
			if (w) void this.followUp(w, String(e.data.answer), e.realmId, String(e.data.workId));
		});
	}

	async dispatch(o: { realmId: Id; spaceId: Id; agentId: Id; text: string; from: Id; messageId: number }): Promise<void> {
		const { core } = this;
		const agent = core.getActor(o.realmId, o.agentId)!;
		const msg = core.postMessage(o.realmId, o.spaceId, o.agentId, { text: "", status: "working", meta: { activity: [] as Step[] }, requestId: `reply:${o.messageId}:${o.agentId}` });
		if (!msg.created) return; // a replayed dispatch must not answer twice
		core.setPresence(o.realmId, o.agentId, "working");
		const activity: Step[] = [];
		const push = (text: string) => this.live(core.updateMessage(o.realmId, msg.message.id, o.agentId, { text, meta: { activity } }));
		const step = async (name: string, args: string, preview: string) => {
			const s: Step = { id: `s${activity.length}`, name, args, status: "running" };
			activity.push(s);
			push("");
			await sleep(this.stepMs);
			s.status = "done";
			s.preview = preview;
			push("");
		};
		try {
			if (/korjaa|fix|kaatuu|crash|checkout|incident/i.test(o.text) && handleOf(o.agentId) === "ops") {
				await step("k8s_list_pods", '{"namespace":"demo-apps"}', "checkout-api-74bd  CrashLoopBackOff  6 restarts");
				await step("k8s_logs", '{"pod":"checkout-api-74bd","previous":true}', "FATAL: database pool size must be > 0");
				await step("k8s_get_configmap", '{"name":"checkout-config"}', "POOL_SIZE=0");
				const text = "Root cause: `checkout-api` crashes at startup because `POOL_SIZE=0` in its ConfigMap. Evidence: the crashed container's log says *database pool size must be > 0*. Proposed fix: set `POOL_SIZE=4`. I need an approver to confirm before I change the live system.";
				core.updateMessage(o.realmId, msg.message.id, o.agentId, { text, meta: { activity }, status: "done" });
				const space = core.getSpace(o.realmId, o.spaceId)!;
				const work = core.createWork(o.realmId, { id: `fix-${o.messageId}`, kind: "incident", title: "checkout-api crash loop", goal: "Restore checkout-api", ownerId: o.agentId, spaceId: space.id, state: "working" }, o.agentId);
				core.requestDecision(o.realmId, {
					key: `apply:${work.id}`, workId: work.id, question: "Apply POOL_SIZE=4 to checkout-api and restart it?",
					context: { target: "demo-apps/checkout-api", reason: "POOL_SIZE=0 makes the process exit at startup", changes: [{ key: "POOL_SIZE", from: 0, to: 4 }], restart: "checkout-api" }, urgency: "high",
				}, o.agentId);
				this.waiting.set(work.id, { realmId: o.realmId, spaceId: space.id, agentId: o.agentId, target: "checkout-api" });
			} else {
				await step("memo_recall", `{"query":${JSON.stringify(o.text.slice(0, 30))}}`, "(no related notes)");
				core.updateMessage(o.realmId, msg.message.id, o.agentId, {
					text: `(scripted demo) I am ${agent.name}. No model is connected, so I only run one scenario: tell @ops that checkout is crashing and ask it to fix it.`, meta: { activity }, status: "done",
				});
			}
		} finally {
			core.setPresence(o.realmId, o.agentId, this.waiting.size ? "waiting" : "idle");
		}
	}

	private async followUp(w: { realmId: Id; spaceId: Id; agentId: Id; target: string }, answer: string, realmId: Id, workId: Id) {
		this.waiting.delete(workId);
		const { core } = this;
		core.setPresence(realmId, w.agentId, "working");
		await sleep(this.stepMs);
		if (answer === "approve") {
			core.postMessage(realmId, w.spaceId, w.agentId, { text: `Approved. Applied \`POOL_SIZE=4\` and restarted \`${w.target}\`: 2/2 pods are Running. I will keep watching for a few minutes.`, requestId: `followup:${workId}` });
			core.setWorkState(realmId, workId, "done", w.agentId, { reason: "fix applied" });
		} else {
			core.postMessage(realmId, w.spaceId, w.agentId, { text: "Understood, I will not change anything. The service stays down until someone decides how to proceed.", requestId: `followup:${workId}` });
			core.setWorkState(realmId, workId, "blocked", w.agentId, { reason: "fix rejected" });
		}
		core.setPresence(realmId, w.agentId, "idle");
	}
}
