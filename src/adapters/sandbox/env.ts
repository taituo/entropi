import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { callRunner } from "./backend.ts";
import type { Core } from "../../core/core.ts";
import type { Id } from "../../core/types.ts";
import { failpoint } from "../../runtime/failpoint.ts";
import type { Sandbox, SandboxManager } from "./manager.ts";

/**
 * Pi's ExecutionEnv for a sandbox. Pi's own CodingTools (read, write, edit, bash) call it, so output windows, spill files,
 * timeouts, line scanning and binary readers behave exactly as they do everywhere else in Pi: the real work is done by
 * Pi's NodeExecutionEnv running inside the container (sandbox/runner.mjs). This object only forwards calls.
 * Only what the coding tools use is forwarded; anything else answers `not_supported` instead of pretending.
 * The sandbox is created on first use, so building the env (which Pi does for every tool call and prompt section) costs nothing.
 */
const FORWARD = new Set(["absolutePath", "joinPath", "canonicalPath", "exists", "fileInfo", "readTextFile", "readBinaryFile", "writeFile", "appendFile", "createDir", "listDir", "remove", "renameFile", "openBinaryReader"]);

const enc = (v: any): any => v instanceof Uint8Array ? { $u8: Buffer.from(v).toString("base64") } : Array.isArray(v) ? v.map(enc) : v && typeof v === "object" && !(v instanceof Error) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;

export type EnvHooks = {
	/** Called after a command finished (exit code known). The place for the audit record. */
	afterExec?(command: string, exitCode: number | undefined): void;
};

export function createSandboxEnv(o: { id: string; ensure(): Promise<Sandbox>; hooks?: EnvHooks; recycle?(): Promise<void> }): ExecutionEnv {
	const revive = (sb: Sandbox, v: any): any => {
		if (Array.isArray(v)) return v.map((x) => revive(sb, x));
		if (!v || typeof v !== "object") return v;
		if (v.$u8 !== undefined) return new Uint8Array(Buffer.from(v.$u8, "base64"));
		if (v.$err) { const e: any = v.$err === "ExecutionError" ? new ExecutionError(v.code, v.message) : new FileError(v.code, v.message, v.path); if (v.spillPath) e.spillPath = v.spillPath; return e; }
		if (v.$handle) return new Proxy({}, { get: (_, m: string) => async (...a: any[]) => { // a reader opened inside the sandbox
			a.pop(); // the Context
			const r = (await callRunner(sb.endpoint, sb.token, "/rpc", { h: v.$handle, m, a: enc(a) })).r;
			return revive(sb, r);
		} });
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(sb, x)]));
	};
	const rpc = async (m: string, args: any[]) => {
		const sb = await o.ensure();
		return revive(sb, (await callRunner(sb.endpoint, sb.token, "/rpc", { m, a: enc(args) }, { timeoutMs: 60_000 })).r);
	};
	const exec = async (command: string | readonly string[], options: any, context: Context, recycled = false): Promise<any> => {
		const sb = await o.ensure();
		const { onOutput, ...rest } = options ?? {};
		let result: any;
		await callRunner(sb.endpoint, sb.token, "/exec", { m: "exec", a: [command, rest] }, {
			signal: context.abortSignal, timeoutMs: 3_600_000,
			onLine: (l) => { if (l.o !== undefined) onOutput?.(l.o, context, l.i); if (l.r !== undefined) result = revive(sb, l.r); },
		}).catch((e) => { if (!context.abortSignal?.aborted) throw e; result = err(new ExecutionError("aborted", "aborted")); });
		// A fork bomb leaves the container with no process slots: nothing can start there again. Start a fresh one, once.
		if (result && !result.ok && result.error?.code === "spawn_error" && o.recycle && !recycled) {
			await o.recycle();
			onOutput?.("[the sandbox had run out of processes and was restarted; files in /work are gone]\n", context, 0);
			return exec(command, options, context, true);
		}
		o.hooks?.afterExec?.(Array.isArray(command) ? command.join(" ") : String(command), result?.ok ? result.value.exitCode : undefined);
		return result ?? err(new ExecutionError("unknown", "the sandbox returned no result"));
	};
	return new Proxy({} as ExecutionEnv, {
		get: (_, name: string | symbol) => {
			if (typeof name === "symbol" || name === "then") return undefined; // an env is awaited and logged: it must not look like a promise
			if (name === "id") return o.id;
			if (name === "cwd") return "/work";
			if (name === "cleanup") return async () => {};
			if (name === "exec") return exec;
			if (FORWARD.has(name)) return (...args: any[]) => (args.pop(), rpc(name, args)); // drop the Context: it cannot cross the boundary
			return async () => err(new FileError("not_supported", `${name} is not available in a sandbox`));
		},
	});
}

/** The env for one space's sandbox (the key names it); `afterExec` records what was run. */
export const sandboxEnvFor = (manager: SandboxManager, key: string, hooks?: EnvHooks) => createSandboxEnv({ id: `sandbox:${key}`, ensure: () => manager.ensure(key), hooks, recycle: async () => void (await manager.stop(key)) });

/**
 * What Pi's `env` option needs: given a conversation, the sandbox of its space. A private chat is a space, so it has its own.
 * Running a command is put on the record (who, where, what, exit code); the sandbox's life and limits stay with the manager.
 */
export const sandboxEnvResolver = (host: { core: Core; manager: SandboxManager; locate(conversationId: unknown): { realmId: Id; spaceId: Id; agentId: Id } | undefined }) => (conversationId: unknown): ExecutionEnv | undefined => {
	const loc = host.locate(conversationId);
	if (!loc) return undefined;
	return sandboxEnvFor(host.manager, `${loc.realmId}:${loc.spaceId}`, {
		afterExec: (command, code) => {
			failpoint("sandbox:after-exec"); // test-only: the command ran, its result is not recorded yet
			host.core.record(loc.realmId, loc.agentId, "sandbox.exec", "space", loc.spaceId, { spaceId: loc.spaceId, command: command.slice(0, 200), code: code ?? null });
		},
	});
};
