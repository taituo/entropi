import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Which (realm, space, agent) a Pi conversation belongs to. Written as a conversation document in the very commit that
 * creates the conversation (`init`), so a conversation can never exist without its binding or the other way round.
 * Pi owns this fact; the core stores nothing about it and the index is read back from Pi on every start.
 */
export const Binding = defineDoc<{ realm: string; space: string; agent: string }>({
	kind: "entropi.binding",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ realm: "", space: "", agent: "" }),
});
export const bindingKey = (b: { realm: string; space: string; agent: string }) => `${b.realm}|${b.space}|${b.agent}`;
