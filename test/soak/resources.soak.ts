// Soak 4: resource bounds around a real workload (60 messages incl. a 20k one).
// Measures RSS, open fds and DB/event-log sizes before and after, and fails on
// unreasonable growth. The long runs in soak-1..3 log the same numbers at volume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { OptChat, openMemoryDb } from "../../src/memory/optchat.ts";
import { makeWorld, until } from "../pi-world.ts";
import { obs, tmpDir, snapResources, obsDelta, msgs, shortText, longText } from "./support.ts";

test("soak-4: RSS, fds and log sizes stay bounded across a 60-message workload", { timeout: 900_000 }, async () => {
	const dir = tmpDir("entropi-soak-4-");
	const coreDb = join(dir, "core.sqlite");
	const memDb = join(dir, "memory.sqlite");
	const w = await makeWorld({
		dbPath: coreDb, storage: new MemoryStorage(),
		runtime: { keepRecentTokens: 4000, viewBytes: 4000, memory: new OptChat(openMemoryDb(memDb)) },
	});
	w.runtime.builder.gapMs = 0;
	await w.start();
	const before = snapResources(w.core, coreDb, memDb);
	const done = () => msgs(w.core).filter((m: any) => m.kind === "agent" && m.status === "done");
	for (let i = 1; i <= 60; i++) {
		const text = i === 30 ? longText(20_000, i) : shortText(i);
		const n = done().length;
		w.core.postMessage("main", "incidents", "human:anna", { text: `@ops ${text}`, dispatchTo: ["agent:ops"] });
		await until(() => done().length === n + 1, 120_000);
	}
	await w.runtime.builder.idle();
	await w.pump.idle();
	const after = snapResources(w.core, coreDb, memDb);
	// Quiet period: nothing running, nothing should keep growing.
	const rssSamples = [after.rssMb];
	for (let i = 0; i < 3; i++) {
		await new Promise((r) => setTimeout(r, 10_000));
		rssSamples.push(Math.round(process.memoryUsage().rss / 1048576));
	}
	obsDelta("soak-4 workload", before, after);
	obs("soak-4 quiet rss", rssSamples);
	const perMsgKb = ((after.coreDbMb - before.coreDbMb) * 1024) / 60;
	obs("soak-4 per message", { coreDbKb: perMsgKb.toFixed(1), eventsAdded: after.events - before.events });
	assert.ok(after.fds - before.fds <= 5, `no fd leak (${before.fds} -> ${after.fds})`);
	assert.ok(after.rssMb - before.rssMb < 150, `RSS growth bounded (${(after.rssMb - before.rssMb).toFixed(0)} MB for 60 messages)`);
	assert.ok(after.coreDbMb < 10, `core db small (${after.coreDbMb.toFixed(2)} MB)`);
	assert.ok(after.memDbMb < 10, `memory db small (${after.memDbMb.toFixed(2)} MB)`);
	assert.ok(perMsgKb < 20, `event log grows with the content, not the history (${perMsgKb.toFixed(1)} kB/message)`);
	assert.ok(Math.max(...rssSamples) - Math.min(...rssSamples) < 15, "RSS stable while idle");
	await w.close();
	const closed = snapResources(w.core, coreDb, memDb);
	obs("soak-4 after close", { fds: closed.fds });
});
