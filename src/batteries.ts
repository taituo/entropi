// The bundled adapters, for building a server out of parts. Unlike the main entry these follow the adapters' own pace:
// Pi Durable is experimental and pinned, so what wraps it can change in a minor release.
export { configFromEnv, sandboxFromEnv } from "./config.ts";
export type { Config, SandboxSettings } from "./config.ts";
export { buildInference, inferenceFromEnv } from "./adapters/pi/inference.ts";
export type { Inference, InferenceConfig, ModelRef } from "./adapters/pi/inference.ts";
export { k8sExtension } from "./adapters/pi/k8s-tools.ts";
export type { ToolHost } from "./adapters/pi/tools.ts";
export { PiRuntime } from "./adapters/pi/runtime.ts";
export { SandboxManager } from "./adapters/sandbox/manager.ts";
export { PodmanSandbox } from "./adapters/sandbox/podman.ts";
export { inCluster, KubeSandbox } from "./adapters/sandbox/kube.ts";
export { ScriptedAgents } from "./adapters/demo/scripted.ts";
export { FakeWorld } from "./adapters/fake-world/world.ts";
export { OptChat, openMemoryDb } from "./memory/optchat.ts";
// Front desk / router: the opinionated receiver channel (batteries side; the core stays free of opinions).
export { FrontDesk, ROUTER_AGENTS, DEFAULT_THRESHOLD, formatNotice, lacksContext, parseCorrection, isSmallTalk } from "./adapters/router/router.ts";
export type { RouteOutcome, FrontDeskOptions } from "./adapters/router/router.ts";
export type { AgentDesc, Classification, Classifier, Clarifier, ClarifyResult } from "./adapters/router/ports.ts";
export { FakeClassifier, FakeClarifier, fakeScores } from "./adapters/router/fake.ts";
export { OpenRouterClassifier, OpenRouterClarifier, RouterModelError, classifierSystemPrompt, clarifierSystemPrompt, DEFAULT_CLASSIFIER_MODEL, DEFAULT_CLARIFIER_MODEL } from "./adapters/router/openrouter.ts";
export { MemoryFeedback, FileFeedback } from "./adapters/router/feedback.ts";
export type { Correction, FeedbackStore } from "./adapters/router/feedback.ts";
export { runSimulation, confusionMatrix, percentile, isMulti, formatConfusion, portClassify } from "./adapters/router/simulate.ts";
export type { SimItem, SimReport, SimPrediction, Confusion } from "./adapters/router/simulate.ts";
