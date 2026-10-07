// A real model uses the sandbox: writes code, runs it, and cannot reach the internet from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PodmanSandbox } from "../../src/adapters/sandbox/podman.ts";
import { makeWorld, until } from "../pi-world.ts";

const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "localhost/crew-sandbox:dev";
const live = !!process.env.LOCAL_LLM_BASE_URL && (await PodmanSandbox.available()) && (await PodmanSandbox.hasImage(IMAGE));
const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

test("5. a real model writes and runs code in the sandbox, and the sandbox is airgapped", { skip: !live, timeout: 400_000 }, async () => {
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), real: true, sandboxDir: mkdtempSync(join(tmpdir(), "entropi-sbx-")) });
	await w.start();
	const before = spawnSync("podman", ["ps", "-a", "--filter", "label=app=entropi-sandbox", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout;
	try {
		w.core.postMessage("main", "incidents", "human:anna", {
			text: "@developer In your sandbox, write a Python file fib.py that prints the first 12 Fibonacci numbers separated by spaces, run it, and tell me exactly what it printed. Then try `curl -sS -m 4 https://example.com` in the sandbox and tell me whether it worked.",
			dispatchTo: ["agent:developer"],
		});
		await until(() => w.core.listMessages("main", "incidents", "human:anna").some((m) => m.authorId === "agent:developer" && m.kind === "agent" && m.status === "done"), 300_000);
		const r = w.core.listMessages("main", "incidents", "human:anna").find((m) => m.authorId === "agent:developer" && m.kind === "agent")!;
		obs("5 answer", r.text);
		obs("5 tools", (r.meta.activity as any[]).map((a) => `${a.name}:${a.status}`));
		assert.match(r.text, /0 1 1 2 3 5 8 13 21 34 55 89/);
		assert.ok((r.meta.activity as any[]).some((a) => a.name === "bash" && a.status === "done"));
		assert.match(r.text, /fail|not work|couldn.t|could not|unable|no network|unreachable|resolve|error|didn.t|did not/i, "the model reports that the internet is not reachable");
	} finally {
		await w.close();
		const after = spawnSync("podman", ["ps", "-a", "--filter", "label=app=entropi-sandbox", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
		for (const n of after.filter((n) => !before.includes(n))) spawnSync("podman", ["rm", "-f", "-t", "0", n]);
	}
});
