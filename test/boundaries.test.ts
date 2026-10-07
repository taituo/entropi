import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);

test("the core imports only itself and Node built-ins: no Pi, no adapters, no UI", () => {
	for (const f of walk("src/core").filter((f) => f.endsWith(".ts"))) {
		for (const spec of importsOf(f)) {
			const ok = spec.startsWith("node:") || (spec.startsWith("./") && !spec.includes("adapters"));
			assert.ok(ok, `${f} imports "${spec}"`);
		}
	}
});

const rel = (f: string) => f.replace(/\\/g, "/");
const resolved = (file: string, spec: string) => rel(join(file, "..", spec)).replace(/\.ts$/, "");
const tsFiles = (dir: string) => walk(dir).filter((f) => f.endsWith(".ts"));
const stripComments = (s: string) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");

test("the memory service sits next to the core and may only use the core's ports and types", () => {
	for (const f of tsFiles("src/memory")) for (const spec of importsOf(f)) {
		const ok = spec.startsWith("node:") || spec.startsWith("./") || /^\.\.\/core\/(ports|types)\.ts$/.test(spec);
		assert.ok(ok, `${f} imports "${spec}"`);
	}
});

test("adapters never import each other: only Node, packages, themselves, the core, the memory service and the shared runtime helpers", () => {
	for (const f of tsFiles("src/adapters")) {
		const mine = rel(f).split("/")[2];
		for (const spec of importsOf(f).filter((s) => s.startsWith("."))) {
			const target = resolved(f, spec);
			const dir = target.split("/");
			const inAdapters = target.startsWith("src/adapters/");
			assert.ok(!inAdapters || dir[2] === mine, `${f} imports another adapter: "${spec}"`);
			assert.ok(inAdapters || /^src\/(core|memory|runtime)\//.test(target), `${f} reaches into "${spec}" (HTTP, server and seed are not for adapters)`);
		}
	}
});

test("nothing outside the core reaches into the core's database; infra calls stay on the trusted surface, away from transports and agent tools", () => {
	for (const f of tsFiles("src").filter((f) => !rel(f).startsWith("src/core/"))) {
		assert.ok(!/\bcore\.db\b/.test(stripComments(readFileSync(f, "utf8"))), `${f} uses core.db directly: add a core operation instead`);
	}
	const untrusted = [...tsFiles("src/http"), "src/adapters/pi/tools.ts", "src/adapters/demo/scripted.ts"];
	for (const f of untrusted) assert.ok(!/\.trusted\b/.test(stripComments(readFileSync(f, "utf8"))), `${f} must not hold the trusted surface`);
	for (const f of tsFiles("src/http")) assert.ok(!/\.trusted\b/.test(readFileSync(f, "utf8")), `${f}: HTTP only gets actor-checked operations`);
});

test("the core does not know the memory service or any adapter", () => {
	for (const f of tsFiles("src/core")) for (const spec of importsOf(f)) assert.ok(!/memory|adapters|http|runtime/.test(spec), `${f} imports "${spec}"`);
});
