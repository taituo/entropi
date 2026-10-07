import type { Core } from "../core/core.ts";
import { SYSTEM } from "../core/core.ts";
import type { EntropiSource, SourceEvent } from "../core/ports.ts";
import type { ExternalRef, Id } from "../core/types.ts";

/**
 * Connects an external source to the core: every state change the source reports is cached on the ExternalRef that points at
 * it (the source stays the truth). What it MEANS is policy and belongs to the caller: `onChange` sees changes of linked things
 * (e.g. mark work done when something got healthy), `onUnlinked` sees changes of things nobody tracks yet (e.g. open a case).
 * The bridge itself decides nothing and writes only through the core's normal, checked operations.
 */
export function bridgeSource(core: Core, source: EntropiSource, o: {
	realmId: Id;
	onChange?(e: SourceEvent, ref: ExternalRef): void | Promise<void>;
	onUnlinked?(e: SourceEvent): void | Promise<void>;
	onError?(e: unknown): void;
}): { stop(): void; done: Promise<void> } {
	const ac = new AbortController();
	const done = (async () => {
		for await (const e of source.observe(ac.signal)) {
			try {
				const ref = core.getRef(o.realmId, e.workRef.source, e.workRef.externalId);
				if (!ref) { await o.onUnlinked?.(e); continue; }
				const updated = core.observeRef(o.realmId, e.workRef.source, e.workRef.externalId, e.state, SYSTEM);
				if (ref.state !== e.state) await o.onChange?.(e, updated);
			} catch (err) {
				(o.onError ?? ((x) => console.warn("[source]", (x as Error).message)))(err);
			}
		}
	})();
	return { stop: () => ac.abort(), done };
}
