import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntropi } from "../src/index.ts";
import { FrontDesk } from "../src/adapters/router/router.ts";
import { FakeClassifier } from "../src/adapters/router/fake.ts";
import { ROUTER_FLAG, isRouterEnabled } from "../src/adapters/router/flag.ts";

test("the flag: strictly ENTROPI_EXPERIMENTAL_ROUTER=1 arms it, everything else is off", () => {
	assert.equal(ROUTER_FLAG, "ENTROPI_EXPERIMENTAL_ROUTER");
	assert.equal(isRouterEnabled({}), false);
	assert.equal(isRouterEnabled({ ENTROPI_EXPERIMENTAL_ROUTER: "" }), false);
	assert.equal(isRouterEnabled({ ENTROPI_EXPERIMENTAL_ROUTER: "0" }), false);
	assert.equal(isRouterEnabled({ ENTROPI_EXPERIMENTAL_ROUTER: "true" }), false, "only the documented value arms it");
	assert.equal(isRouterEnabled({ ENTROPI_EXPERIMENTAL_ROUTER: "1" }), true);
});

test("every router source file is marked experimental", () => {
	const files = readdirSync("src/adapters/router").filter((f) => f.endsWith(".ts"));
	assert.ok(files.length >= 6, `router adapter present (${files.join(", ")})`);
	for (const f of files) {
		assert.match(readFileSync(join("src/adapters/router", f), "utf8"), /experimental/, `${f} must carry the experimental marker`);
	}
});

test("the live eval script stays behind the flag (never touches the key file when off)", () => {
	const src = readFileSync("scripts/router-live.mjs", "utf8");
	assert.match(src, /ENTROPI_EXPERIMENTAL_ROUTER/);
	const flagLine = src.split("\n").findIndex((l) => l.includes('process.env.ENTROPI_EXPERIMENTAL_ROUTER !== "1"'));
	const keyLine = src.split("\n").findIndex((l) => l.includes("readFileSync(keyPath"));
	assert.ok(flagLine >= 0 && keyLine >= 0 && flagLine < keyLine, "the flag is checked before the key is read");
});

const withFlag = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
	const prev = process.env[ROUTER_FLAG];
	try {
		if (value === undefined) delete process.env[ROUTER_FLAG];
		else process.env[ROUTER_FLAG] = value;
		return await fn();
	} finally {
		if (prev === undefined) delete process.env[ROUTER_FLAG];
		else process.env[ROUTER_FLAG] = prev;
	}
};

const seed = (dir: string) => ({
	dataDir: dir,
	realm: {
		id: "acme", name: "Acme",
		agents: ["ops", "developer", "reviewer", "insight"].map((h) => ({ id: `agent:${h}`, name: h, spaces: ["front"] })),
		spaces: [{ id: "front", topic: "Front desk", welcome: false }],
	},
	router: { classifier: new FakeClassifier(), spaceId: "front" } as const,
});

test("flag off: no router activates even with the option given (no model, no key)", async () => {
	await withFlag(undefined, async () => {
		const e = await createEntropi(seed(mkdtempSync(join(tmpdir(), "entropi-router-off-"))));
		try {
			assert.equal(e.router, undefined, "no FrontDesk without the flag");
		} finally {
			await e.close();
		}
	});
});

test("flag on: the front desk activates and routes end to end with the fake classifier", async () => {
	await withFlag("1", async () => {
		const e = await createEntropi(seed(mkdtempSync(join(tmpdir(), "entropi-router-on-"))));
		try {
			assert.ok(e.router instanceof FrontDesk, "FrontDesk is assembled");
			e.core.addActor("acme", { id: "human:anni", kind: "human", name: "Anni", roles: ["operator"] }, "system");
			const human = e.core.postMessage("acme", "front", "human:anni", { text: "checkout-api pod looping again in prod crashloopbackoff" });
			const out = await e.router!.handle({ text: human.message.text, by: "human:anni", messageId: human.message.id });
			assert.equal(out.kind, "routed");
			assert.equal((out as { agent: string }).agent, "ops");
			const notices = e.core.listMessages("acme", "front", "human:anni", 50).filter((m) => m.kind === "notice").map((m) => m.text);
			assert.ok(notices.some((t) => t.startsWith("-> @ops (")), `visible routing line, got: ${JSON.stringify(notices)}`);
		} finally {
			await e.close();
		}
	});
});

test("explicit enabled:false wins over the flag (fail-safe off)", async () => {
	await withFlag("1", async () => {
		const s = seed(mkdtempSync(join(tmpdir(), "entropi-router-deny-")));
		const e = await createEntropi({ ...s, router: { ...s.router, enabled: false } });
		try {
			assert.equal(e.router, undefined);
		} finally {
			await e.close();
		}
	});
});
