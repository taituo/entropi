// experimental: kill switch for the front desk router. Everything router-shaped stays fully off by
// default; only ENTROPI_EXPERIMENTAL_ROUTER=1 (plus an explicit opt-in where one exists, e.g. the
// createEntropi router option or the live-eval script) activates model calls or key usage.

/** Environment variable that arms the experimental front desk router. Strictly "1"; anything else is off. */
export const ROUTER_FLAG = "ENTROPI_EXPERIMENTAL_ROUTER";

/** True only when the experimental router flag is explicitly "1". Default off, no other value arms it. */
export function isRouterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[ROUTER_FLAG] === "1";
}
