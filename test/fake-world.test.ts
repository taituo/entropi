import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { makeWorld, until } from "./pi-world.ts";
import { FakeWorld } from "../src/adapters/fake-world/world.ts";
import { k8sExtension } from "../src/adapters/pi/k8s-tools.ts";
import { bridgeSource } from "../src/runtime/sources.ts";
import { Core } from "../src/core/core.ts";
import { openDb } from "../src/core/db.ts";

const collect = (w: FakeWorld) => {
	const ac = new AbortController(); const got: any[] = [];
	const done = (async () => { for await (const e of w.observe(ac.signal)) got.push(e); })();
	return { got, stop: async () => { ac.abort(); await done; } };
};

test("source port: state changes come out of observe, reads through query, changes through invoke (idempotently)", async () => {
	const w = new FakeWorld(); const c = collect(w);
	await until(() => c.got.length === 2);
	assert.deepEqual(c.got.map((e) => [e.workRef.externalId, e.state]), [["deployment/demo-apps/checkout-api", "unhealthy"], ["deployment/demo-apps/orders-api", "healthy"]]);
	const pods: any = await w.query("pods/demo-apps");
	assert.match(pods.data.find((p: any) => p.deployment === "checkout-api").state, /CrashLoopBackOff/);
	assert.match((await w.query("logs/demo-apps/" + pods.data[0].name, { previous: true }) as any).data.lines.join(), /POOL_SIZE=0/);
	await assert.rejects(w.query("configmap/kube-system/x"), /no such namespace/);
	// a config change alone does not heal the pods; the restart does, and a repeated restart announces nothing new
	await w.invoke("apply-configmap", { namespace: "demo-apps", name: "checkout-config", data: { POOL_SIZE: "10" } }, { idempotencyKey: "k1" });
	assert.equal((await w.query("deployment/demo-apps/checkout-api")).state, "unhealthy");
	await w.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, { idempotencyKey: "k2" });
	await w.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, { idempotencyKey: "k2" });
	await until(() => c.got.length === 3);
	assert.deepEqual([c.got[2].workRef.externalId, c.got[2].state], ["deployment/demo-apps/checkout-api", "healthy"]);
	assert.equal(c.got.length, 3);
	await c.stop();
});

test("idempotency: a repeated key executes nothing and returns the first result; a new key is a new effect; no key is refused", async () => {
	const w = new FakeWorld();
	const pods = async () => ((await w.query("pods/demo-apps")) as any).data.map((p: any) => p.name).join();
	const first = await w.invoke("apply-configmap", { namespace: "demo-apps", name: "checkout-config", data: { POOL_SIZE: "10" } }, { idempotencyKey: "a" });
	await w.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, { idempotencyKey: "r1" });
	const afterFirst = await pods();
	assert.equal(w.executed, 2);
	// the same keys again, as a replay after a crash would send them, even after the world moved on
	await w.invoke("apply-configmap", { namespace: "demo-apps", name: "checkout-config", data: { POOL_SIZE: "99" } }, { idempotencyKey: "a" }).then((r) => assert.deepEqual(r, first, "the first result comes back"));
	await w.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, { idempotencyKey: "r1" });
	assert.equal(w.executed, 2, "nothing ran twice");
	assert.equal(await pods(), afterFirst, "no second rollout: the pods are the same");
	assert.equal(((await w.query("configmap/demo-apps/checkout-config")) as any).data.POOL_SIZE, "10", "the replayed apply did not overwrite");
	await w.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, { idempotencyKey: "r2" });
	assert.equal(w.executed, 3, "a different key is a different effect");
	assert.notEqual(await pods(), afterFirst);
	await assert.rejects(w.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, {} as any), /idempotency key/);
});

test("the bridge caches observed state on linked refs and reports unlinked changes to policy; it decides nothing itself", async () => {
	const core = new Core(openDb(":memory:"));
	core.createRealm({ id: "main", name: "Main", kind: "team" });
	core.createWork("main", { id: "w1", kind: "task", title: "Fix checkout", state: "working" }, "system");
	core.linkRef("main", "w1", { source: "k8s", externalId: "deployment/demo-apps/checkout-api", state: "unknown" }, "system");
	const world = new FakeWorld(); const changes: string[] = []; const unlinked: string[] = [];
	const b = bridgeSource(core, world, { realmId: "main", onChange: (e) => { changes.push(e.state); }, onUnlinked: (e) => { unlinked.push(e.workRef.externalId); } });
	await until(() => unlinked.length === 1);
	assert.equal(core.getRef("main", "k8s", "deployment/demo-apps/checkout-api")!.state, "unhealthy");
	assert.deepEqual(unlinked, ["deployment/demo-apps/orders-api"]);
	assert.equal(core.getWork("main", "w1")!.state, "working", "the bridge changes no work state");
	await world.invoke("apply-configmap", { namespace: "demo-apps", name: "checkout-config", data: { POOL_SIZE: "10" } }, { idempotencyKey: "k1" });
	await world.invoke("restart-deployment", { namespace: "demo-apps", name: "checkout-api" }, { idempotencyKey: "k2" });
	await until(() => changes.length === 2);
	assert.equal(core.getRef("main", "k8s", "deployment/demo-apps/checkout-api")!.state, "healthy");
	b.stop(); await b.done;
});

test("ops reads the cluster, asks a human before changing it, and sees the fix take effect", async () => {
	const world = new FakeWorld();
	const calls: { action: string; key: string }[] = [];
	const spy: typeof world = Object.assign(Object.create(world), { invoke: (a: string, i: any, c: any) => (calls.push({ action: a, key: c.idempotencyKey }), world.invoke(a, i, c)) });
	const w = await makeWorld({ dbPath: ":memory:", storage: new MemoryStorage(), runtime: { extensions: (host: any) => [k8sExtension({ ...host, source: () => spy, readNamespaces: ["demo-apps"], writeNamespaces: ["demo-apps"] })] } });
	await w.start();
	w.core.postMessage("main", "incidents", "human:anna", { text: "@ops k8sfix checkout", dispatchTo: ["agent:ops"] });
	await until(() => w.core.openDecisions("main").length === 1);
	const card = w.core.openDecisions("main")[0];
	assert.deepEqual((card as any).context.changes, [{ key: "POOL_SIZE", from: "0", to: "10" }], "the card shows the exact before/after");
	assert.equal((await world.query("deployment/demo-apps/checkout-api")).state, "unhealthy", "nothing changed before the decision");
	w.core.decide("main", card.id, "human:anna", "approve", "go");
	const reply = () => w.core.listMessages("main", "incidents", "human:anna").find((m: any) => m.kind === "agent")!;
	await until(() => reply().status === "done");
	assert.equal((await world.query("deployment/demo-apps/checkout-api")).state, "healthy");
	assert.match(reply().text, /checkout-api-\S+ 1\/1 Running restarts=0/, "the agent's last look at the cluster shows the fix");
	assert.deepEqual(calls.map((c) => c.action), ["apply-configmap", "restart-deployment"]);
	assert.deepEqual(calls.map((c) => c.key), [`decision:${card.id}:apply`, `decision:${card.id}:restart`], "the keys come from the decision id, so a rerun of the task repeats them");
	assert.deepEqual((reply().meta.activity as any[]).map((a: any) => a.name), ["k8s_pods", "k8s_apply_configmap", "k8s_pods"]);
	await w.close();
});

test("namespaces outside the allow-list are refused by the tools", async () => {
	const world = new FakeWorld(); let out = "";
	const ext: any = k8sExtension({ source: () => world, readNamespaces: ["demo-apps"], writeNamespaces: [] } as any);
	const t = ext.tools.find((x: any) => x.name === "k8s_pods");
	out = (await t.execute({ namespace: "kube-system" })).content[0].text;
	assert.match(out, /not readable/);
	const a = ext.tools.find((x: any) => x.name === "k8s_apply_configmap");
	assert.match((await a.execute({ namespace: "demo-apps", name: "checkout-config", data: { POOL_SIZE: "1" }, reason: "x" }, {}, {})).content[0].text, /not writable/);
});
