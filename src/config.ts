const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
// Keys arrive from files and secrets, often with a trailing newline that would corrupt a header.
for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "SESSION_SECRET", "OIDC_CLIENT_SECRET"]) if (env[k]) env[k] = env[k]!.trim();

export const config = {
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
		/** "oidc" in production, "dev" for local runs without Keycloak (never in a cluster). */
		mode: (env.AUTH_MODE ?? "oidc") as "oidc" | "dev",
		issuerPublic: env.OIDC_ISSUER_PUBLIC ?? "",
		issuerInternal: env.OIDC_ISSUER_INTERNAL ?? env.OIDC_ISSUER_PUBLIC ?? "",
		clientId: env.OIDC_CLIENT_ID ?? "entropi",
		clientSecret: env.OIDC_CLIENT_SECRET ?? "",
	},
};
export type Config = typeof config;
