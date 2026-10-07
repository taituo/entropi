import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxBackend, SandboxState } from "./backend.ts";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "sandbox", "runner.mjs");
const LABEL = "app=entropi-sandbox";
/** Pi's own execution environment (a few plain JS files, no dependencies), mounted read-only: the runner is a thin RPC around it. */
const PI_ENV = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-durable/env/node")));

const run = (args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string; err: string }> =>
	new Promise((res) => execFile("podman", args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (e: any, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err) })));

export type PodmanOptions = {
	/** Where per-sandbox socket directories live (host side). */
	dir: string;
	/** "none" (default): no network at all, airgapped. "public": outbound access via pasta/slirp; it can also reach the LAN, so only on hosts you trust. */
	network?: "none" | "public";
	memory?: string;
	cpus?: string;
	maxSeconds?: number;
	/** Containers of this backend instance carry this extra label and `list` sees only them, so independent managers (tests, a second instance) never count or sweep each other's containers. */
	pool?: string;
};

/**
 * Rootless podman on this machine. Everything that Crewpi's pod spec guarantees is here too: non-root user, read-only root
 * filesystem, no capabilities, no privilege escalation, resource and pid limits, a hard lifetime, no host paths except the
 * socket directory. And unlike a pod it needs no network: the runner listens on a unix socket in a directory shared with the host.
 */
export class PodmanSandbox implements SandboxBackend {
	readonly name = "podman";
	private o: Required<Omit<PodmanOptions, "pool">> & { pool?: string };
	constructor(o: PodmanOptions) {
		this.o = { network: "none", memory: "1g", cpus: "1", maxSeconds: 7200, ...o };
	}

	static async available(): Promise<boolean> {
		return (await run(["--version"], 5000)).code === 0;
	}

	static async hasImage(image: string): Promise<boolean> {
		return (await run(["image", "exists", image], 10_000)).code === 0;
	}

	socketDir(name: string) {
		return join(this.o.dir, name);
	}

	/** The exact `podman run` arguments (exported so a test can check every isolation property). */
	runArgs(a: { name: string; key: string; token: string; image: string }): string[] {
		return [
			"run", "-d", "--name", a.name, "--label", LABEL, "--label", `entropi.key=${a.key.slice(0, 60)}`, ...(this.o.pool ? ["--label", `entropi.pool=${this.o.pool}`] : []),
			"--user", "10001:10001", "--read-only",
			"--tmpfs", "/tmp:rw,size=256m,mode=1777", "--tmpfs", "/work:rw,size=1g,mode=0777",
			"--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", this.o.memory, "--cpus", this.o.cpus,
			"--timeout", String(this.o.maxSeconds), "--network", this.o.network === "none" ? "none" : "pasta",
			"-v", `${this.socketDir(a.name)}:/sock`, "-v", `${RUNNER}:/opt/runner.mjs:ro`, "-v", `${PI_ENV}:/opt/pi-env:ro`,
			"-e", `RUNNER_TOKEN=${a.token}`, "-e", "WORK_DIR=/work", "-e", "LISTEN_SOCKET=/sock/runner.sock",
			a.image, "node", "/opt/runner.mjs",
		];
	}

	async start(a: { name: string; key: string; token: string; image: string }) {
		if (!(await PodmanSandbox.hasImage(a.image))) throw new Error(`sandbox image ${a.image} is not on this machine. Build it once with scripts/build-sandbox.sh (or podman load a saved copy); no network is needed afterwards.`);
		const dir = this.socketDir(a.name);
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o777); // the container's non-root user must be able to create the socket here
		rmSync(join(dir, "runner.sock"), { force: true });
		const r = await run(this.runArgs(a));
		if (r.code !== 0) throw new Error(`podman could not start the sandbox: ${r.err.trim().split("\n").pop()}`);
	}

	async inspect(name: string): Promise<SandboxState> {
		const r = await run(["inspect", name, "--format", "{{.State.Status}}|{{.State.ExitCode}}"], 10_000);
		if (r.code !== 0) return { state: "missing" };
		const [status, exit] = r.out.trim().split("|");
		if (status === "running") return { state: "running", endpoint: { kind: "unix", socketPath: join(this.socketDir(name), "runner.sock") } };
		if (status === "created" || status === "initialized") return { state: "starting" };
		return { state: "failed", detail: `container is ${status} (exit ${exit})` };
	}

	/** Returns when the container is really gone: a heavily loaded host (or a container full of processes) can make one `rm` give up first. */
	async remove(name: string) {
		for (let attempt = 0; attempt < 4; attempt++) {
			await run(["rm", "-f", "-t", "0", name], 30_000);
			if ((await this.inspect(name)).state === "missing") break;
		}
		rmSync(this.socketDir(name), { recursive: true, force: true });
	}

	async list() {
		const r = await run(["ps", "-a", "--filter", `label=${this.o.pool ? `entropi.pool=${this.o.pool}` : LABEL}`, "--format", "{{.Names}}"], 15_000);
		return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
	}
}
