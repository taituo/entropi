import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, CompactionTask, configure, defineExtension, defineTool, hook } from "@earendil-works/pi-durable";
import { handleOf } from "../../core/core.ts";
import { failpoint } from "../../runtime/failpoint.ts";
import type { Core } from "../../core/core.ts";
import type { OptChat } from "../../memory/optchat.ts";
import type { DecisionRequest, Id } from "../../core/types.ts";

/** What the agent-facing tools need from the runtime, as an interface so tools stay testable and the runtime stays swappable. */
export interface ToolHost {
	core: Core;
	memory: OptChat;
	viewBytes: number;
	locate(conversationId: unknown): { realmId: Id; spaceId: Id; agentId: Id } | undefined;
	/** The run in progress in this conversation (read from Pi's placed submission, so it is right even with queued follow-ups). */
	currentRun(conversationId: unknown): Promise<{ runId: string; depth: number } | undefined>;
	/** Model for hidden helper work, normally a cheap one. */
	consultModel(conversationId: unknown): { provider: string; modelId: string } | undefined;
	waitDecision(realmId: Id, decisionId: Id, signal?: AbortSignal): Promise<DecisionRequest>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t.length > 6000 ? `${t.slice(0, 6000)}\n... [truncated]` : t }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });


/**
 * Ask the humans in the agent's space to decide, and wait. Work item and decision are keyed by the Pi task id, so a rerun after a
 * crash finds the same ones (the tool is replay-safe because of this). Shared by every tool that needs a human's yes.
 */
export async function askApproval(host: ToolHost, api: { taskId: unknown; conversationId: unknown }, context: { abortSignal?: AbortSignal }, req: { action: string; details: Record<string, unknown> }): Promise<{ approved: boolean; text: string; by: string | null; decision: DecisionRequest }> {
	const { core } = host;
	const loc = host.locate(api.conversationId);
	if (!loc) throw new Error("this conversation is not attached to a space");
	const workId = `appr-${api.taskId}`;
	core.createWork(loc.realmId, { id: workId, kind: "approval", title: req.action, ownerId: loc.agentId, spaceId: loc.spaceId, state: "working" }, loc.agentId);
	const { decision } = core.requestDecision(loc.realmId, { key: `ap:${api.taskId}`, workId, question: req.action, context: req.details, urgency: "normal", requiredAuthority: "approver" }, loc.agentId);
	failpoint("tool:after-decision");
	const d = await host.waitDecision(loc.realmId, decision.id, context.abortSignal);
	const by = d.decidedBy ? core.getActor(loc.realmId, d.decidedBy)?.name ?? d.decidedBy : null;
	if (d.status === "decided" && d.answer === d.options[0]) {
		core.setWorkState(loc.realmId, workId, "done", loc.agentId, { reason: "approved" });
		return { approved: true, by, decision: d, text: `APPROVED by ${by}${d.note ? ` (${d.note})` : ""}.` };
	}
	core.setWorkState(loc.realmId, workId, "cancelled", loc.agentId, { reason: d.status });
	return { approved: false, by, decision: d, text: d.status === "decided"
		? `REJECTED by ${by}${d.note ? `: ${d.note}` : ""}. Do not retry or work around this; report it and stop.`
		: `The request ended without an approval (${d.status}). Do not act; report it and stop.` };
}

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
				const run = await host.currentRun(api.conversationId);
				const r = core.delegate(loc.realmId, { spaceId: loc.spaceId, from: loc.agentId, to, request: args.request, requestId: `ask:${api.taskId}`, depth: run?.depth ?? 0, runId: run?.runId });
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
				return text((await askApproval(host, api, context, { action: args.action, details: { target: args.target, reason: args.reason } })).text);
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

	// Hidden helper work, as opposed to ask_agent's visible hand-over to a colleague: a Pi subagent. The child conversation is
	// owned by this tool call's task, so stopping the parent stops the helper; a rerun after a crash finds the same child.
	const consult = defineTool({
		name: "consult",
		description: "Ask a private helper a self-contained question (it has no tools and no memory of this chat) and get its answer back. Use it for side work such as summarising or classifying text. It is not visible to people.",
		parameters: Type.Object({ question: Type.String({ description: "Everything the helper needs, in one message" }) }),
		replay: "safe",
		execute: async (args, api, context) => {
			try {
				const model = host.consultModel(api.conversationId);
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { ...(model ? { model } : {}), extensions: { remove: [extension] }, instructions: "You are a helper. Answer the question briefly and exactly. You have no tools." });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context);
				const handle = await api.conversation(child, context);
				if (!handle) throw new Error("helper conversation vanished");
				const settled = await (await handle.submit({ type: "input", content: args.question, requestId: `sub:${api.taskId}` }, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") return fail(new Error(`the helper did not answer (${settled.status})`));
				const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				const t = (entry?.model?.[0] as any)?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
				return text(t || "(the helper returned nothing)");
			} catch (e) {
				return fail(e);
			}
		},
	});

	const extension: ReturnType<typeof defineExtension> = defineExtension({
		name: "entropi",
		tools: [askAgent, requestApproval, memoryZoom, consult],
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
	return extension;
}