import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLED_EVENT_TYPES, CORE_EVENT_TYPES, EVENT_TYPES } from "../src/core/events.ts";

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const ts = (dir: string) => walk(dir).filter((f) => f.endsWith(".ts"));
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// ---------------------------------------------------------------------------------------------------- events

test("event types: the list is the stable public vocabulary; this snapshot changes only on purpose (new type = minor, rename or removal = major)", () => {
	assert.deepEqual([...CORE_EVENT_TYPES], [
		"realm.created", "actor.joined", "actor.updated", "presence.changed", "work.created", "work.state", "ref.linked", "ref.observed",
		"decision.requested", "decision.decided", "decision.cancelled", "decision.expired", "space.created", "space.archived", "space.reopened",
		"message.posted", "message.updated", "message.completed", "delegation.requested", "attention.raised", "attention.resolved",
	]);
	assert.deepEqual([...BUNDLED_EVENT_TYPES], ["agent.stopped", "agent.compacted", "sandbox.exec", "sandbox.stopped", "k8s.apply"]);
	assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, "no duplicates");
	for (const t of EVENT_TYPES) assert.match(t, /^[a-z][a-z0-9]*\.[a-z]+$/);
});

test("event types: the code emits exactly the listed ones (nothing unlisted, nothing listed that no code emits)", () => {
	const core = readFileSync("src/core/core.ts", "utf8");
	const emitted = new Set<string>();
	for (const line of core.split("\n").filter((l) => /this\.emit\(/.test(l))) for (const m of line.matchAll(/"([a-z]+\.[a-z]+)"/g)) emitted.add(m[1]);
	if (/this\.emit\([^`\n]*`space\.\$\{/.test(core)) { emitted.add("space.archived"); emitted.add("space.reopened"); }
	assert.deepEqual([...emitted].sort(), [...CORE_EVENT_TYPES].sort(), "core.ts emits a type that is not in src/core/events.ts, or the list has one nobody emits");

	const recorded = new Set<string>();
	for (const f of ts("src")) for (const m of readFileSync(f, "utf8").matchAll(/\.record\([^,\n]+,[^,\n]+,\s*"([a-z][a-z0-9]*\.[a-z]+)"/g)) recorded.add(m[1]);
	assert.deepEqual([...recorded].sort(), [...BUNDLED_EVENT_TYPES].sort(), "an adapter records a type that is not in BUNDLED_EVENT_TYPES (or the reverse)");
});

// ---------------------------------------------------------------------------------------------------- boundaries

test("the public entries do not leak adapters into the core: the core entry's whole import closure stays in src/core", () => {
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const spec of importsOf(file)) {
			if (spec.startsWith("node:")) continue;
			assert.ok(spec.startsWith("."), `${file} imports the package "${spec}": the core has no dependencies`);
			const target = resolve(file, "..", spec);
			assert.ok(target.startsWith(resolve("src/core") + "/"), `${file} reaches out of the core: "${spec}"`);
			visit(target);
		}
	};
	visit(resolve("src/core/index.ts"));
	assert.ok(seen.size >= 6);
});

test("only the composition root and the batteries entry know adapters; nothing inside imports them back", () => {
	const entries = { "src/index.ts": ["./entropi.ts", "./core/index.ts", "./seed.ts"], "src/http/index.ts": ["./app.ts"], "src/core/index.ts": null };
	for (const [file, allowed] of Object.entries(entries)) {
		const specs = importsOf(file).filter((s) => s.startsWith("."));
		for (const s of specs) assert.ok(!/adapters|batteries|server/.test(s), `${file} exports from "${s}": adapters belong behind entropi/batteries`);
		if (allowed) for (const s of specs) assert.ok(allowed.includes(s), `${file} has an unexpected export source "${s}"`);
	}
	const roots = /(^|\/)(entropi|index|batteries|server)(\.ts)?$/;
	for (const f of ts("src").filter((f) => !/^src\/(index|entropi|batteries|server)\.ts$/.test(f) && !/^src\/(core|http)\/index\.ts$/.test(f))) {
		for (const s of importsOf(f).filter((x) => x.startsWith("."))) assert.ok(!roots.test(s), `${f} imports "${s}": the composition files are imported by nobody but callers`);
	}
	for (const f of ts("src/http")) for (const s of importsOf(f)) assert.ok(!s.includes("adapters"), `${f} imports an adapter ("${s}"): HTTP talks to the core and ports only`);
});

// ---------------------------------------------------------------------------------------------------- the built package

const OUT = resolve(".tmp-build");
test("the package: it builds, every exports target exists and runs under plain Node, and the public names are exactly the snapshot", { timeout: 120_000 }, async () => {
	assert.ok(!pkg.private, "a package that others depend on is not private");
	assert.match(pkg.version, /^\d+\.\d+\.\d+/);
	rmSync(OUT, { recursive: true, force: true });
	execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--outDir", OUT], { stdio: "pipe" });
	try {
		const map = (p: string) => join(OUT, p.replace(/^\.\/dist\//, ""));
		const names: Record<string, string[]> = {};
		for (const [sub, target] of Object.entries<any>(pkg.exports)) {
			if (typeof target === "string") continue;
			assert.ok(existsSync(map(target.default)), `${sub}: ${target.default} is not built`);
			assert.ok(existsSync(map(target.types)), `${sub}: ${target.types} is not built`);
			names[sub] = Object.keys(await import(pathToFileURL(map(target.default)).href)).sort();
		}
		const core = ["BUNDLED_EVENT_TYPES", "CAPABILITIES", "CORE_EVENT_TYPES", "Core", "CoreError", "EVENT_TYPES", "SYSTEM", "conflict", "forbidden", "handleOf", "hasRole", "invalid", "notFound", "openDb"];
		assert.deepEqual(names["./core"], core);
		assert.deepEqual(names["."], [...core, "VERSION", "createEntropi", "seedRealm"].sort());
		assert.deepEqual(names["./http"], ["createApp"]);
		assert.deepEqual(names["./batteries"], ["FakeWorld", "KubeSandbox", "OptChat", "PiRuntime", "PodmanSandbox", "SandboxManager", "ScriptedAgents", "buildInference", "configFromEnv", "inCluster", "inferenceFromEnv", "k8sExtension", "openMemoryDb", "sandboxFromEnv"]);
		const main: any = await import(pathToFileURL(join(OUT, "index.js")).href);
		assert.equal(main.VERSION, pkg.version, "VERSION is the package's version");
		assert.deepEqual([...main.EVENT_TYPES], [...EVENT_TYPES]);
		// what ships: the server and demo cast are examples, not part of the package
		assert.ok(pkg.files.includes("!dist/server.*") && pkg.files.includes("!dist/demo"));
		// a bare consumer of the core entry loads without Pi, sandboxes or HTTP: nothing but the core's own files was needed
		assert.ok(existsSync(join(OUT, "core", "index.js")));
	} finally {
		rmSync(OUT, { recursive: true, force: true });
	}
});
