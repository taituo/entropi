import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);

test("the core imports only itself and Node built-ins: no Pi, no Temporal, no adapters, no UI", () => {
	for (const f of walk("src/core").filter((f) => f.endsWith(".ts"))) {
		for (const spec of importsOf(f)) {
			const ok = spec.startsWith("node:") || (spec.startsWith("./") && !spec.includes("adapters"));
			assert.ok(ok, `${f} imports "${spec}"`);
		}
	}
});

test("nothing in the project depends on Temporal", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => d.startsWith("@temporalio")));
	for (const f of walk("src").filter((f) => f.endsWith(".ts"))) assert.ok(!/temporal/i.test(readFileSync(f, "utf8")), `${f} mentions Temporal`);
});
