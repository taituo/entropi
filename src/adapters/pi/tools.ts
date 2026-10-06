import { Type } from "@earendil-works/pi-ai";
import { CompactionTask, defineExtension, defineTool, hook } from "@earendil-works/pi-durable";
import { handleOf } from "../../core/core.ts";
import { failpoint } from "../../runtime/failpoint.ts";
import type { Core } from "../../core/core.ts";
import type { OptChat } from "../../core/optchat.ts";
import type { DecisionRequest, Id } from "../../core/types.ts";

/** What the agent-facing tools need from the runtime, as an interface so tools stay testable and the runtime stays swappable. */
export interface ToolHost {
	core: Core;
	memory: OptChat;
	viewBytes: number;
	locate(conversationId: unknown): { realmId: Id; spaceId: Id; agentId: Id } | undefined;
	/** Hops from the human message that started the run this conversation is in. Read from the core, so it survives restarts. */
	depthOf(conversationId: unknown): number;
	/** Identity of the run in progress (the agent message being written), to bound how often it can delegate. */
	runOf(conversationId: unknown): string | undefined;
	waitDecision(realmId: Id, decisionId: Id, signal?: AbortSignal): Promise<DecisionRequest>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t.length > 6000 ? `${t.slice(0, 6000)}\n... [truncated]` : t }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });

/**
 * The tools every agent gets. Each one is `replay: "safe"` AND idempotent: its effect is keyed by the Pi task id, so a
 * rerun after a crash finds what the first attempt already did instead of doing it twice. (Safety must not depend on a
 * model's judgement about an "interrupted" message: a model that retries blindly would otherwise duplicate the effect.)
 */
export function entropiExtension(host: ToolHost) {
	const { core } = host;

	const askAgent = defineTool({
		name: "ask_agent",
		description: "Hand a task to another agent in THIS space. The other agent cannot see your tool results, so the request must be self-contained. It answers in the space; this call returns immediately.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent handle, e.g. developer, reviewer, ops" }),
			request: Type.String({ description: "Self-contained request with all facts the other agent needs" }),
		}),
		replay: "safe",
		execute: async (args, api) => {
			try {
				const loc = host.locate(api.conversationId);
				if (!loc) throw new Error("this conversation is not attached to a space");
				const space = core.getSpace(loc.realmId, loc.spaceId)!;
				const handle = args.agent.toLowerCase().replace(/^@/, "");
				const to = space.agentIds.find((id) => handleOf(id) === handle);
				if (!to) throw new Error(`no agent "${args.agent}" in this space. Present: ${space.agentIds.map(handleOf).join(", ")}`);
				const r = core.delegate(loc.realmId, { spaceId: loc.spaceId, from: loc.agentId, to, request: args.request, requestId: `ask:${api.taskId}`, depth: host.depthOf(api.conversationId), runId: host.runOf(api.conversationId) });
				return text(`${r.created ? "Asked" : "Already asked"} @${handle}. Their answer will appear in the space.`);
			} catch (e) {
				return fail(e);
			}
		},
	});

	const requestApproval = defineTool({
		name: "request_approval",
		description: "Ask the humans in this space to approve an action BEFORE you do it. Blocks until someone with the approver role decides. Only for actions you will then perform yourself. Never use it to request permissions or access you lack: tell the humans plainly what is blocked instead.",
		parameters: Type.Object({
			action: Type.String({ description: "What will be done, one line" }),
			target: Type.String({ description: "System or object affected" }),
			reason: Type.String({ description: "Why, with the evidence" }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			try {
				const loc = host.locate(api.conversationId);
				if (!loc) throw new Error("this conversation is not attached to a space");
				// Both ids come from the task id: a rerun after a crash lands on the same work item and the same decision.
				const workId = `appr-${api.taskId}`;
				core.createWork(loc.realmId, { id: workId, kind: "approval", title: args.action, ownerId: loc.agentId, spaceId: loc.spaceId, state: "working" }, loc.agentId);
				const { decision } = core.requestDecision(loc.realmId, {
					key: `ap:${api.taskId}`, workId, question: args.action, context: { target: args.target, reason: args.reason }, urgency: "normal", requiredAuthority: "approver",
				}, loc.agentId);
				failpoint("tool:after-decision");
				const d = await host.waitDecision(loc.realmId, decision.id, context.abortSignal);
				const by = d.decidedBy ? core.getActor(loc.realmId, d.decidedBy)?.name ?? d.decidedBy : null;
				if (d.status === "decided" && d.answer === d.options[0]) {
					core.setWorkState(loc.realmId, workId, "done", loc.agentId, { reason: "approved" });
					return text(`APPROVED by ${by}${d.note ? ` (${d.note})` : ""}.`);
				}
				core.setWorkState(loc.realmId, workId, "cancelled", loc.agentId, { reason: d.status });
				return text(d.status === "decided"
					? `REJECTED by ${by}${d.note ? `: ${d.note}` : ""}. Do not retry or work around this; report it and stop.`
					: `The request ended without an approval (${d.status}). Do not act; report it and stop.`);
			} catch (e) {
				return fail(e);
			}
		},
	});

	const memoryZoom = defineTool({
		name: "memory_zoom",
		description: "Expand one line of the compressed memory view (an id like #2.5) into finer detail or, at level 0, the original message.",
		parameters: Type.Object({ id: Type.String({ description: 'Line id, e.g. "#2.5"' }) }),
		replay: "safe",
		execute: async (args, api) => {
			try {
				return text(host.memory.zoom(String(api.conversationId), args.id));
			} catch (e) {
				return fail(e);
			}
		},
	});

	return defineExtension({
		name: "entropi",
		tools: [askAgent, requestApproval, memoryZoom],
		hooks: [
			// When Pi compacts the context, replace its linear summary with the OptChat view of everything before the kept tail:
			// recent messages verbatim, older ones ever coarser, every line zoomable.
			hook(CompactionTask, {
				beforeCompact: (c: any, api: any) => {
					const thread = String(api.conversationId);
					const upTo = host.memory.lastLeafBefore(thread, Number(c.firstKept));
					if (upTo < 3) return undefined; // too little recorded history: let Pi summarise as usual
					return { summary: host.memory.renderView(thread, host.memory.fitView(thread, upTo, host.viewBytes)) };
				},
			}),
		] as any,
	});
}
