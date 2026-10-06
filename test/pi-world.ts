import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { Core } from "../src/core/core.ts";
import { openDb } from "../src/core/db.ts";
import { PiRuntime } from "../src/adapters/pi/runtime.ts";
import { buildInference, inferenceFromEnv } from "../src/adapters/pi/inference.ts";
import { DispatchPump } from "../src/runtime/pump.ts";
import { seedRealm } from "../src/seed.ts";

export const until = async (fn: () => boolean, ms = 8000) => {
	const t = Date.now();
	while (!fn()) {
		if (Date.now() - t > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

const lastRole = (ctx: any) => ctx.messages.at(-1)?.role;
const userText = (ctx: any) => {
	const m = [...ctx.messages].reverse().find((x: any) => x.role === "user");
	return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b: any) => b.text ?? "").join("");
};

/**
 * A deterministic "model" that is a pure function of the transcript, so a restarted process answers exactly like the
 * dead one would have (a scripted queue would be lost with the process).
 *   "@... approve"  -> calls request_approval, then reports the verdict it saw
 *   "@... delegate" -> calls ask_agent(developer), then says it asked
 *   anything else   -> answers "echo: <text>"
 */
export function scriptedModel() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] } as any);
	const step = async (ctx: any) => {
		faux.appendResponses([step]); // a pure function of the transcript: always ready for the next call
		const text = userText(ctx);
		const mine = lastRole(ctx);
		if (mine === "toolResult") {
			const r: any = ctx.messages.at(-1);
			const out = (r.content ?? []).map((b: any) => b.text ?? "").join("");
			return fauxAssistantMessage(`done: ${out}`);
		}
		if (/\bapprove\b/.test(text)) return fauxAssistantMessage([fauxToolCall("request_approval", { action: "Apply POOL_SIZE=4", target: "checkout-api", reason: "pool size is 0" })], { stopReason: "toolUse" });
		if (/\bfanout\b/.test(text)) return fauxAssistantMessage(["developer", "reviewer", "insight"].map((a, i) => fauxToolCall("ask_agent", { agent: a, request: `task ${i} for ${a}` }, { id: `fan${i}` })), { stopReason: "toolUse" });
		if (/\bdelegate\b/.test(text)) return fauxAssistantMessage([fauxToolCall("ask_agent", { agent: "developer", request: "please fix the pool size" })], { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText(`echo: ${text.replace(/^\[[^\]]*\]\s*[^:]*:\s*/, "")}`)]);
	};
	faux.setResponses([step as any]);
	return faux;
}

export type World = Awaited<ReturnType<typeof makeWorld>>;
export async function makeWorld(o: { dbPath: string; storage: Storage; real?: boolean; runtime?: Partial<ConstructorParameters<typeof PiRuntime>[0]> }) {
	const core = new Core(openDb(o.dbPath));
	seedRealm(core, "main");
	core.addActor("main", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] });
	const faux = scriptedModel();
	const inference = o.real
		? buildInference(inferenceFromEnv(process.env))
		: buildInference({ airgapped: true, defaultModel: "faux/scripted", perAgent: {} }, [{ id: "faux", provider: faux.provider }]);
	const live: string[] = [];
	const runtime = new PiRuntime({ core, storage: o.storage, inference, live: (m) => live.push(m.text), ...o.runtime });
	const pump = new DispatchPump(core, runtime);
	return { core, runtime, pump, faux, live, start: async () => { await runtime.start(); pump.start(); }, close: async () => { pump.stop(); await runtime.close(); } };
}
