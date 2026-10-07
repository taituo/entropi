// experimental: front desk router ports (off unless ENTROPI_EXPERIMENTAL_ROUTER=1).
/**
 * Router ports: the two model seams of the front desk, as interfaces. The core stays free of opinions: it never
 * imports these, and the router adapter speaks to the core only through actor-checked operations. Any model
 * (Jev/openjev, OpenRouter, a local endpoint) plugs in by implementing one or both ports.
 */

export type AgentDesc = { handle: string; description: string };

export type Classification = {
	/** Agent handle, or "none" when no agent fits. Unknown handles are treated as "no confident answer". */
	agent: string;
	confidence: number;
};

/** Fast model: one message in, one agent (or "none") out. Must never throw away a message: on model failure it throws and the caller falls back to a human choice. */
export interface Classifier {
	classify(message: string, agents: AgentDesc[]): Promise<Classification>;
}

export type ClarifyResult =
	| { kind: "clear"; text: string }
	| { kind: "question"; question: string };

/** Language model for messy messages only: either a self-contained request, or one question back to the human. */
export interface Clarifier {
	clarify(message: string, agents: AgentDesc[]): Promise<ClarifyResult>;
}
