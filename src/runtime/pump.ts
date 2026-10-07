import type { Core, Trusted } from "../core/core.ts";
import { handleOf } from "../core/core.ts";
import type { AgentDispatcher } from "../core/ports.ts";
import { failpoint } from "./failpoint.ts";

/**
 * Delivers the core's outbox to an agent runtime. At-least-once by construction (a row stays pending until the runtime
 * confirms), so runtimes must be idempotent per (message, agent): Pi's `requestId` gives exactly that.
 * Delivery never blocks the sender: rows run independently, and a runtime may take as long as it likes to confirm.
 */
export class DispatchPump {
	private core: Core;
	private runtime: AgentDispatcher;
	private inflight = new Set<number>();
	private off?: () => void;
	readonly maxAttempts: number;
	/** Resolves when nothing is in flight (tests, shutdown). */
	private idleWaiters: (() => void)[] = [];

	constructor(core: Core, runtime: AgentDispatcher, o: { maxAttempts?: number } = {}) {
		this.core = core;
		this.runtime = runtime;
		this.maxAttempts = o.maxAttempts ?? 3;
	}

	/** Subscribe to new hand-overs and drain whatever a previous process left behind. */
	start() {
		this.off = this.core.subscribe((e) => { if (e.type === "message.posted" && Number(e.data.dispatch) > 0) this.kick(); });
		this.kick();
	}

	stop() {
		this.off?.();
	}

	kick() {
		for (const item of this.core.trusted.pendingOutbox()) {
			if (this.inflight.has(item.id)) continue;
			this.inflight.add(item.id);
			void this.deliver(item).finally(() => {
				this.inflight.delete(item.id);
				if (!this.inflight.size) for (const w of this.idleWaiters.splice(0)) w();
			});
		}
	}

	private async deliver(item: ReturnType<Trusted["pendingOutbox"]>[number]) {
		try {
			await this.runtime.dispatch({ realmId: item.realmId, spaceId: item.spaceId, agentId: item.agentId, text: item.text, from: item.from, messageId: item.messageId, depth: item.depth });
			failpoint("pump:before-mark");
			this.core.trusted.markOutbox(item.id, "sent");
		} catch (e) {
			const msg = (e as Error).message;
			if (this.core.trusted.bumpOutbox(item.id, msg) >= this.maxAttempts) {
				this.core.trusted.markOutbox(item.id, "failed", msg);
				this.core.postMessage(item.realmId, item.spaceId, "system", { kind: "notice", text: `Could not reach ${handleOf(item.agentId)}: ${msg}` });
			} else setTimeout(() => this.kick(), 500).unref();
		}
	}

	idle(): Promise<void> {
		return this.inflight.size ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
	}
}
