type Env = Record<string, string | undefined>;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
// Keys arrive from files and secrets, often with a trailing newline that would corrupt a header.
const trimmed = (env: Env, ...keys: string[]) => { for (const k of keys) if (env[k]) env[k] = env[k]!.trim(); };

/** Server settings from the environment; with an empty one, the defaults. A program that builds on Entropi passes its own values instead. */
export function configFromEnv(env: Env = {}) {
	trimmed(env, "OPENAI_API_KEY", "OPENROUTER_API_KEY", "SESSION_SECRET");
	return {
		port: num(env.PORT, 8080),
		dataDir: env.DATA_DIR ?? "./data",
		publicUrl: (env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, ""),
		cookieSecure: env.COOKIE_SECURE === "true",
		sessionSecret: env.SESSION_SECRET ?? "dev-only-secret-change-me",
		/** Realm every signed-in person joins automatically. */
		defaultRealm: env.DEFAULT_REALM ?? "main",
		brand: {
			name: env.BRAND_NAME ?? "Entropi",
			tagline: env.BRAND_TAGLINE ?? "Humans and agents, one calm place",
			accent: env.BRAND_ACCENT ?? "#6d5efc",
		},
		auth: {
			/** "dev" = local picker (laptops, tests). "proxy" = trust the identity a reverse proxy puts in a header. Authentication itself is outside Entropi. */
			mode: (env.AUTH_MODE ?? "dev") as "dev" | "proxy",
			/** proxy mode: header carrying the stable user id (e.g. X-Forwarded-User). */
			userHeader: env.AUTH_USER_HEADER ?? "x-forwarded-user",
			/** proxy mode, optional: header with a display name. */
			nameHeader: env.AUTH_NAME_HEADER ?? "",
			/** proxy mode, optional: header with comma-separated roles (viewer, operator, approver, admin). */
			rolesHeader: env.AUTH_ROLES_HEADER ?? "",
			/** proxy mode: roles when no roles header is configured or present. */
			defaultRoles: (env.AUTH_DEFAULT_ROLES ?? "viewer").split(",").map((r) => r.trim()).filter(Boolean),
			/** proxy mode: where "sign out" goes (e.g. /oauth2/sign_out). */
			logoutUrl: env.AUTH_LOGOUT_URL ?? "",
		},
	};
}
export const config = configFromEnv(process.env);
export type Config = ReturnType<typeof configFromEnv>;

/** Sandbox settings from the environment. */
export function sandboxFromEnv(env: Env = {}) {
	return {
		/** auto: the cluster when running in one, else podman on this machine if it is installed, else none. */
		backend: (env.SANDBOX_BACKEND ?? "auto") as "auto" | "podman" | "kube" | "none",
		image: env.SANDBOX_IMAGE ?? "localhost/entropi-sandbox:dev",
		/** none (default): the sandbox has no network at all. public: outbound web via pasta (it can also reach your LAN: only on hosts you trust). AIRGAPPED=true forces none. */
		network: (env.AIRGAPPED === "true" ? "none" : (env.SANDBOX_NETWORK ?? "none")) as "none" | "public",
		max: num(env.SANDBOX_MAX, 2),
		idleMin: num(env.SANDBOX_IDLE_MIN, 30),
		namespace: env.SANDBOX_NAMESPACE ?? "entropi-sandboxes",
	};
}
export const sandboxConfig = sandboxFromEnv(process.env);
export type SandboxSettings = ReturnType<typeof sandboxFromEnv>;
