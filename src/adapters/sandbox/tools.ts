import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Core } from "../../core/core.ts";
import type { Id } from "../../core/types.ts";
import { failpoint } from "../../runtime/failpoint.ts";
import type { SandboxManager } from "./manager.ts";

const clip = (s: string, n = 7000) => (s.length > n ? `${s.slice(0, n)}\n... [truncated ${s.length - n} chars]` : s);
const text = (t: string) => ({ content: [{ type: "text" as const, text: clip(t) }] });
const fail = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });

export const sandboxKey = (realmId: Id, spaceId: Id) => `${realmId}:${spaceId}`;

/**
 * The agent-facing half of the sandbox, ported from Crewpi. The sandbox belongs to the space the agent is working in
 * (a private chat has its own). Reads and writes are replay-safe; running a command is not (it is not idempotent), so
 * after a crash the model is told the command was interrupted instead of it being silently run twice.
 */
export function sandboxExtension(host: { core: Core; manager: SandboxManager; locate(conversationId: unknown): { realmId: Id; spaceId: Id; agentId: Id } | undefined }) {
	function tool(name: string, description: string, parameters: any, run: (args: any, sb: Awaited<ReturnType<SandboxManager["ensure"]>>, who: { realmId: Id; spaceId: Id; agentId: Id }) => Promise<string>, replay: "safe" | "unsafe") {
		return defineTool({
			name, description, parameters, replay,
			executionMode: "sequential", // one runner, one command at a time
			execute: async (args: any, api: any) => {
				try {
					const who = host.locate(api.conversationId);
					if (!who) throw new Error("conversation is not attached to a space");
					const sb = await host.manager.ensure(sandboxKey(who.realmId, who.spaceId));
					return text(await run(args, sb, who));
				} catch (e) {
					return fail(`Error: ${(e as Error).message}`);
				}
			},
		} as any);
	}
	const call = (sb: any, m: "GET" | "POST" | "PUT", p: string, b?: string | object, t?: number) => host.manager.call<any>(sb, m, p, b, t);

	const exec = tool(
		"sbx_exec",
		"Run a shell command in this space's sandbox (working dir /work, files persist between calls until the sandbox expires, ~30 min idle). The sandbox has node 22, npm, python3, git, jq and curl, no secrets, and no access to the rest of the system. It may have no network at all. Returns exit code, stdout and stderr. Not for anything that must survive: results you want to keep go elsewhere.",
		Type.Object({ command: Type.String({ description: "Shell command (sh -c)" }), timeout_s: Type.Optional(Type.Number({ description: "Seconds, default 60, max 300" })), cwd: Type.Optional(Type.String({ description: "Directory under /work" })) }),
		async (a, sb, who) => {
			const r = await call(sb, "POST", "/exec", { command: a.command, cwd: a.cwd, timeoutS: a.timeout_s }, ((a.timeout_s ?? 60) + 15) * 1000);
			failpoint("sandbox:after-exec"); // test-only: the command ran, its result was not recorded yet
			host.core.record(who.realmId, who.agentId, "sandbox.exec", "space", who.spaceId, { spaceId: who.spaceId, command: String(a.command).slice(0, 200), code: r.code });
			return `exit ${r.code}${r.timedOut ? " (TIMED OUT and killed)" : ""}${r.signal ? ` signal ${r.signal}` : ""} in ${r.ms} ms${r.truncated ? " (output truncated)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
		},
		"unsafe",
	);
	const write = tool("sbx_write", "Write a file in the sandbox (path under /work; creates directories).", Type.Object({ path: Type.String(), content: Type.String() }),
		async (a, sb) => `Wrote ${a.path} (${(await call(sb, "PUT", `/file?path=${encodeURIComponent(a.path)}`, a.content)).bytes} bytes).`, "safe");
	const read = tool("sbx_read", "Read a text file from the sandbox (path under /work).", Type.Object({ path: Type.String() }),
		async (a, sb) => (await call(sb, "GET", `/file?path=${encodeURIComponent(a.path)}`)).content, "safe");
	const ls = tool("sbx_ls", "List a sandbox directory (default /work).", Type.Object({ path: Type.Optional(Type.String()) }),
		async (a, sb) => (await call(sb, "GET", `/ls?path=${encodeURIComponent(a.path ?? ".")}`)).entries.map((e: any) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(8)} ${e.name}`).join("\n") || "(empty)", "safe");

	return defineExtension({ name: "sandbox", tools: [exec, write, read, ls] as any });
}
