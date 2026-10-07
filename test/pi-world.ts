import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { Core } from "../src/core/core.ts";
import { openDb } from "../src/core/db.ts";
import { PiRuntime } from "../src/adapters/pi/runtime.ts";
import { buildInference, inferenceFromEnv } from "../src/adapters/pi/inference.ts";
import { DispatchPump } from "../src/runtime/pump.ts";
import { seedRealm } from "../src/seed.ts";
import { demoRealm } from "../src/demo/realm.ts";
import { PodmanSandbox } from "../src/adapters/sandbox/podman.ts";
import { SandboxManager } from "../src/adapters/sandbox/manager.ts";
import { sandboxEnvResolver } from "../src/adapters/sandbox/env.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export const until = async (fn: () => boolean, ms = 8000) => {
	const t = Date.now();
	while (!fn()) {
		if (Date.now() - t > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

const lastRole = (ctx: any) => ctx.messages.at(-1)?.role;
/** Tool results since the last user message: where we are in a multi-step tool script. */
const resultsSoFar = (ctx: any) => { let n = 0; for (let i = ctx.messages.length - 1; i >= 0 && ctx.messages[i].role !== "user"; i--) if (ctx.messages[i].role === "toolResult") n++; return n; };
const lastResultText = (ctx: any) => { const r = [...ctx.messages].reverse().find((m: any) => m.role === "toolResult"); return (r?.content ?? []).map((b: any) => b.text ?? "").join(""); };
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
export function makeGate() {
	let release!: () => void;
	const p = new Promise<void>((r) => (release = r));
	return { p, release };
}

export function scriptedModel(gate = makeGate()) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", input: ["text"] }], ...(process.env.SLOW_STREAM ? { tokensPerSecond: Number(process.env.SLOW_STREAM) } : {}) } as any);
	const step = async (ctx: any, options?: any) => {
		faux.appendResponses([step]); // a pure function of the transcript: always ready for the next call
		const text = userText(ctx);
		if (/\bHOLD\b/.test(text) && lastRole(ctx) !== "toolResult") await Promise.race([gate.p, new Promise((_, rej) => options?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }))]); // blocks until released, but honours abort like a real provider
		const mine = lastRole(ctx);
		if (/\bsandbox\b/.test(text)) {
			const n = resultsSoFar(ctx);
			if (n === 0) return fauxAssistantMessage([fauxToolCall("write", { path: "hello.py", content: 'print("sum", sum(range(10)))' })], { stopReason: "toolUse" });
			if (n === 1) return fauxAssistantMessage([fauxToolCall("bash", { command: "python3 hello.py" })], { stopReason: "toolUse" });
			return fauxAssistantMessage(`done: ${lastResultText(ctx).replace(/\s+/g, " ").slice(0, 160)}`);
		}
		const zoom = /\bzoom (#\d+\.\d+)/.exec(text);
		if (zoom) return resultsSoFar(ctx) === 0 ? fauxAssistantMessage([fauxToolCall("memory_zoom", { id: zoom[1] })], { stopReason: "toolUse" }) : fauxAssistantMessage(`done: ${lastResultText(ctx)}`);
		if (/\bk8sfix\b/.test(text)) {
			const n = resultsSoFar(ctx);
			if (n === 0) return fauxAssistantMessage([fauxToolCall("k8s_pods", { namespace: "demo-apps" })], { stopReason: "toolUse" });
			if (n === 1) return fauxAssistantMessage([fauxToolCall("k8s_apply_configmap", { namespace: "demo-apps", name: "checkout-config", data: { POOL_SIZE: "10" }, restart: "checkout-api", reason: "POOL_SIZE=0 crash loop" })], { stopReason: "toolUse" });
			if (n === 2) return fauxAssistantMessage([fauxToolCall("k8s_pods", { namespace: "demo-apps" })], { stopReason: "toolUse" });
			return fauxAssistantMessage(`done: ${lastResultText(ctx).replace(/\s+/g, " ").slice(0, 200)}`);
		}
		if (/\bcountrun\b/.test(text)) {
			if (resultsSoFar(ctx) === 0) return fauxAssistantMessage([fauxToolCall("bash", { command: "echo x >> /work/count.txt; wc -l < /work/count.txt" })], { stopReason: "toolUse" });
			return fauxAssistantMessage(`done: ${lastResultText(ctx).replace(/\s+/g, " ").slice(0, 200)}`);
		}
		if (mine === "toolResult") {
			const r: any = ctx.messages.at(-1);
			const out = (r.content ?? []).map((b: any) => b.text ?? "").join("");
			return fauxAssistantMessage(`done: ${out}`);
		}
		if (/\bapprove\b/.test(text)) return fauxAssistantMessage([fauxToolCall("request_approval", { action: "Apply POOL_SIZE=4", target: "checkout-api", reason: "pool size is 0" })], { stopReason: "toolUse" });
		if (/\bfanout\b/.test(text)) return fauxAssistantMessage(["developer", "reviewer", "insight"].map((a, i) => fauxToolCall("ask_agent", { agent: a, request: `task ${i} for ${a}` }, { id: `fan${i}` })), { stopReason: "toolUse" });
		if (/\bconsult\b/.test(text)) return fauxAssistantMessage([fauxToolCall("consult", { question: /HOLDHELPER/.test(text) ? "HOLD question" : "what is the answer" })], { stopReason: "toolUse" });
		if (/\bdelegate\b/.test(text)) return fauxAssistantMessage([fauxToolCall("ask_agent", { agent: "developer", request: /HOLDDEV/.test(text) ? "HOLD: please fix the pool size" : "please fix the pool size" })], { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText(`echo: ${text.replace(/^\[[^\]]*\]\s*[^:]*:\s*/, "")}`)]);
	};
	faux.setResponses([step as any]);
	return faux;
}

export type World = Awaited<ReturnType<typeof makeWorld>>;
export async function makeWorld(o: { sandboxDir?: string; dbPath: string; storage: Storage; real?: boolean; runtime?: Partial<ConstructorParameters<typeof PiRuntime>[0]> }) {
	const core = new Core(openDb(o.dbPath));
	seedRealm(core, demoRealm("main"));
	core.addActor("main", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] }, "system");
	const gate = makeGate();
	const faux = scriptedModel(gate);
	const inference = o.real
		? buildInference(inferenceFromEnv(process.env))
		: buildInference({ airgapped: true, defaultModel: "faux/scripted", perAgent: {} }, [{ id: "faux", provider: faux.provider }]);
	const live: string[] = [];
	let sandbox: SandboxManager | undefined;
	const extensions: any[] = [CodingTools];
	let env: ((id: unknown) => any) | undefined;
	if (o.sandboxDir) {
		sandbox = new SandboxManager({ db: core.db, backend: new PodmanSandbox({ dir: o.sandboxDir }), image: process.env.SANDBOX_TEST_IMAGE ?? "localhost/crew-sandbox:dev", max: 3 });
		env = sandboxEnvResolver({ core, manager: sandbox, locate: (id: unknown) => runtimeRef.current?.locate(id) });
	}
	const runtimeRef: { current?: PiRuntime } = {};
	const runtime = new PiRuntime({ core, storage: o.storage, inference, live: (m) => live.push(m.text), extensions, env, ...o.runtime });
	runtimeRef.current = runtime;
	const pump = new DispatchPump(core, runtime);
	return { core, runtime, pump, faux, gate, live, sandbox, start: async () => { await runtime.start(); pump.start(); }, close: async () => { pump.stop(); await runtime.close(); } };
}
