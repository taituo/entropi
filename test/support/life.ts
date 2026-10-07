import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One process lifetime of the system (test/crash/child.ts) on the same database files; a failpoint may SIGKILL it. */
export function life(dir: string, action: string, arg = "", env: Record<string, string> = {}): Promise<{ signal: string | null; summary?: any; err: string }> {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, ["test/crash/child.ts", dir, action, arg], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (_code, signal) => {
			const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
			resolve({ signal, summary: line ? JSON.parse(line.slice(8)) : undefined, err });
		});
	});
}
export const tmp = () => mkdtempSync(join(tmpdir(), "entropi-crash-"));
export const done = (s: any) => s.agentMessages.filter((m: any) => m.status === "done");
