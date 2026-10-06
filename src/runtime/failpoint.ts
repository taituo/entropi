/**
 * Test-only crash injection. With ENTROPI_FAILPOINT=<name> the process kills itself (SIGKILL, no cleanup, exactly like a
 * crash or an OOM kill) the moment it reaches that named point. Without the variable it does nothing at all.
 */
export function failpoint(name: string): void {
	if (process.env.ENTROPI_FAILPOINT === name) process.kill(process.pid, "SIGKILL");
}
