import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pi Durable is experimental ("the API changes without notice between releases"): we only ever run the exact version we tested.
test("the Pi packages are pinned to exact versions, and those are the installed ones", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	for (const name of ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"]) {
		const want = pkg.dependencies[name];
		assert.match(want, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, not a range (${want})`);
		assert.equal(JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version, want, `${name} installed != pinned`);
	}
});

test("only one place listens to a conversation, and it does not use the Experimental event stream", () => {
	const users = ["src/adapters/pi/runtime.ts"].filter((f) => /viewState\(/.test(readFileSync(f, "utf8")));
	assert.deepEqual(users, ["src/adapters/pi/runtime.ts"]);
	for (const f of ["src/adapters/pi/runtime.ts", "src/adapters/pi/tools.ts", "src/adapters/pi/transcript.ts"]) assert.ok(!/watchEvents/.test(readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")), `${f} must not use watchEvents`);
	assert.equal((readFileSync("src/adapters/pi/runtime.ts", "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "").match(/viewState\(/g) ?? []).length, 1, "viewState() is called in exactly one place (attach)");
});
