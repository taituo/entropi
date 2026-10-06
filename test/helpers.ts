import { openDb } from "../src/core/db.ts";
import { Core } from "../src/core/core.ts";

/** A fresh in-memory core with a controllable clock. */
export function testCore() {
	const clock = { t: 1_700_000_000_000 };
	const db = openDb(":memory:");
	const core = new Core(db, { now: () => clock.t });
	return { core, db, clock, tick: (ms = 1000) => (clock.t += ms) };
}

/** A realm with a requester agent, an approver, a plain operator and a second approver. */
export function seededRealm() {
	const t = testCore();
	t.core.createRealm({ id: "payments", name: "Payments", kind: "team" });
	t.core.addActor("payments", { id: "agent:ops", kind: "agent", name: "Ops" });
	t.core.addActor("payments", { id: "human:anna", kind: "human", name: "Anna", roles: ["approver"] });
	t.core.addActor("payments", { id: "human:mikko", kind: "human", name: "Mikko", roles: ["approver"] });
	t.core.addActor("payments", { id: "human:olli", kind: "human", name: "Olli", roles: ["operator"] });
	return t;
}
