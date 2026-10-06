import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export type ModelRef = { provider: string; modelId: string };

/**
 * Where models come from. Local first: an OpenAI-compatible endpoint (vLLM, Ollama, llama.cpp, LiteLLM...) on your own
 * machine or cluster is the default, and the system runs fully airgapped with nothing else. Cloud models are an opt-in
 * adapter: a provider is registered only when its key is present, and `AIRGAPPED=true` switches every cloud provider off
 * no matter what keys are around.
 */
export type InferenceConfig = {
	airgapped: boolean;
	local?: { baseUrl: string; model: string; apiKey: string; vision: boolean };
	openaiKey?: string;
	openrouterKey?: string;
	/** "provider/model" for agents without their own override. Defaults to the local model when one is configured. */
	defaultModel?: string;
	/** "provider/model" per agent handle (AGENT_OPS_MODEL=...). */
	perAgent: Record<string, string>;
};

export function inferenceFromEnv(env: NodeJS.ProcessEnv): InferenceConfig {
	const t = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
	const perAgent: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		const m = /^AGENT_([A-Z0-9_]+)_MODEL$/.exec(k);
		if (m && t(v)) perAgent[m[1].toLowerCase().replace(/_/g, "-")] = t(v)!;
	}
	const baseUrl = t(env.LOCAL_LLM_BASE_URL), model = t(env.LOCAL_LLM_MODEL);
	return {
		airgapped: env.AIRGAPPED === "true",
		local: baseUrl && model ? { baseUrl, model, apiKey: t(env.LOCAL_LLM_API_KEY) ?? "not-needed", vision: env.LOCAL_LLM_VISION === "true" } : undefined,
		openaiKey: t(env.OPENAI_API_KEY),
		openrouterKey: t(env.OPENROUTER_API_KEY),
		defaultModel: t(env.INFERENCE_DEFAULT),
		perAgent,
	};
}

export type Inference = { models: Models; providers: string[]; resolve(agentHandle: string): ModelRef | undefined };

const parseRef = (s: string): ModelRef => {
	const i = s.indexOf("/");
	if (i <= 0 || i === s.length - 1) throw new Error(`model "${s}" must look like provider/model`);
	return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
};

/** Register what is configured, nothing else. `extra` lets tests (and future adapters) bring their own providers. */
export function buildInference(cfg: InferenceConfig, extra: { id: string; provider: any }[] = []): Inference {
	const models = createModels();
	const providers: string[] = [];
	if (cfg.local) {
		const l = cfg.local;
		models.setProvider(createProvider({
			id: "local", name: "Local OpenAI-compatible", baseUrl: l.baseUrl,
			// vLLM and Ollama ignore the key, but the OpenAI client refuses to send a request without one.
			auth: { apiKey: { name: "Local LLM", resolve: async () => ({ auth: { apiKey: l.apiKey } }) } },
			models: [{ id: l.model, name: l.model, api: "openai-completions", provider: "local", baseUrl: l.baseUrl, reasoning: false, input: l.vision ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16000 }],
			api: openAICompletionsApi(),
		}) as any);
		providers.push("local");
	}
	if (!cfg.airgapped) {
		if (cfg.openaiKey) { models.setProvider(openaiProvider()); providers.push("openai"); } // reads OPENAI_API_KEY
		if (cfg.openrouterKey) { models.setProvider(openrouterProvider()); providers.push("openrouter"); } // reads OPENROUTER_API_KEY
	}
	for (const x of extra) { models.setProvider(x.provider); providers.push(x.id); }

	const fallback = cfg.defaultModel ?? (cfg.local ? `local/${cfg.local.model}` : undefined);
	const refs = [...Object.values(cfg.perAgent), ...(fallback ? [fallback] : [])];
	for (const r of refs) {
		const { provider } = parseRef(r);
		if (!providers.includes(provider)) {
			const why = cfg.airgapped && ["openai", "openrouter"].includes(provider) ? "AIRGAPPED=true disables cloud providers" : "that provider is not configured";
			throw new Error(`model "${r}" cannot be used: ${why}`);
		}
	}
	return {
		models, providers,
		resolve: (handle) => {
			const ref = cfg.perAgent[handle] ?? fallback;
			return ref ? parseRef(ref) : undefined;
		},
	};
}
