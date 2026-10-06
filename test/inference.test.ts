import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInference, inferenceFromEnv } from "../src/adapters/pi/inference.ts";

const env = (o: Record<string, string>) => inferenceFromEnv(o as any);

test("nothing configured: no provider is registered and nothing is reachable", () => {
	const i = buildInference(env({}));
	assert.deepEqual(i.providers, []);
	assert.equal(i.resolve("ops"), undefined);
});

test("a local endpoint is the default model for every agent and is all that is needed (airgapped)", () => {
	const i = buildInference(env({ AIRGAPPED: "true", LOCAL_LLM_BASE_URL: "http://vllm.svc:8000/v1", LOCAL_LLM_MODEL: "qwen3" }));
	assert.deepEqual(i.providers, ["local"]);
	assert.deepEqual(i.resolve("ops"), { provider: "local", modelId: "qwen3" });
	assert.ok(i.models.getModel("local", "qwen3"));
});

test("cloud is opt-in: keys alone do not make it the default, and AIRGAPPED switches it off whatever keys exist", () => {
	const both = { OPENAI_API_KEY: "sk-x", LOCAL_LLM_BASE_URL: "http://localhost:11434/v1", LOCAL_LLM_MODEL: "llama" };
	const i = buildInference(env(both));
	assert.deepEqual(i.providers, ["local", "openai"]);
	assert.equal(i.resolve("ops")!.provider, "local", "the default stays local");
	assert.equal(buildInference(env({ ...both, AGENT_REVIEWER_MODEL: "openai/gpt-x" })).resolve("reviewer")!.provider, "openai", "an explicit per-agent choice uses the cloud");
	const air = buildInference(env({ ...both, AIRGAPPED: "true" }));
	assert.deepEqual(air.providers, ["local"]);
	assert.throws(() => buildInference(env({ ...both, AIRGAPPED: "true", AGENT_REVIEWER_MODEL: "openai/gpt-x" })), /AIRGAPPED=true disables cloud providers/);
});

test("a model that points at an unconfigured provider fails at startup, not at the first message", () => {
	assert.throws(() => buildInference(env({ INFERENCE_DEFAULT: "openrouter/some-model" })), /not configured/);
	assert.throws(() => buildInference(env({ LOCAL_LLM_BASE_URL: "http://x/v1", LOCAL_LLM_MODEL: "m", INFERENCE_DEFAULT: "nonsense" })), /provider\/model/);
});

test("per-agent overrides are read from AGENT_<HANDLE>_MODEL", () => {
	const i = buildInference(env({ LOCAL_LLM_BASE_URL: "http://x/v1", LOCAL_LLM_MODEL: "small", AGENT_DEVELOPER_MODEL: "local/big" }));
	assert.equal(i.resolve("developer")!.modelId, "big");
	assert.equal(i.resolve("ops")!.modelId, "small");
});
