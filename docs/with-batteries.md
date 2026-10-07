# With batteries

The core is free: it has ports and no opinions. "With batteries" is the one opinionated assembly that works out of the box, and what `npm run demo` and `deploy.sh` run:

- **Agents:** Pi Durable runtime (`src/adapters/pi`), behind `AgentDispatcher` and the optional `AgentControl` abilities.
- **Sandbox:** Pi's `ExecutionEnv` in rootless podman or a Kubernetes pod (`src/adapters/sandbox`, `SandboxBackend`).
- **Memory:** OptChat summary tree in its own SQLite file (`src/memory`, reads through `TranscriptSource`).
- **UI:** the wireframe UI in `public/` over HTTP + SSE.
- **Model:** a local OpenAI-compatible endpoint or gateway.
- **Outside world:** a fake cluster (`EntropiSource`), for the demo.

## Run it

Locally: `scripts/build-sandbox.sh` once, then
`AIRGAPPED=true LOCAL_LLM_BASE_URL=http://localhost:11434/v1 LOCAL_LLM_MODEL=<model> npm run demo`.

In k3s: copy `.deploy.env.example` to `.deploy.env`, set `BASE_DOMAIN` and the model (the key is read from a file and stored only in a cluster Secret), run `./deploy.sh`. It uses its own namespaces, `entropi` and `entropi-sandboxes` (default-deny network policy, quota), and touches nothing else.

**Auth:** dev login in the demo; for real use, the trusted-proxy header with an authenticating proxy in front (oauth2-proxy plus any OIDC provider, Authelia, Authentik, Dex, Zitadel, Tailscale serve identity headers on a tailnet, or Keycloak as one option). Entropi has no login of its own ([steering.md](steering.md)).

## Swapping parts

Drop or replace any battery by implementing its port. The core never imports an adapter, and adapters never import each other (`test/boundaries.test.ts`). No runtime: the API and UI show only the abilities the runtime has. `SANDBOX_BACKEND=none`: agents get no coding tools. Another model: any OpenAI-compatible URL, per agent with `AGENT_<HANDLE>_MODEL`. A real outside system: write an `EntropiSource` (`observe`, `query`, `invoke`); the fake cluster shows the shape.

## To make this a production system you need

- **Real login** (above): an IdP and a proxy that authenticates before Entropi. Note that `deploy.sh` defaults to dev login, fine on a tailnet only.
- **Backups and migrations.** State is SQLite files on one volume; nothing backs them up, and migrations are numbered steps with no rollback.
- **More than one node.** One process owns the files; no failover or scaling.
- **Real adapters** for your cluster, review, CI and workflow systems, with least-privilege credentials.
- **Pi Durable is experimental.** Pinned exactly; read its changelog before bumping.
- **Gateway limits and cost.** Rate limits and spend caps are the gateway's job; Entropi only reports quota errors.
- **Sandbox network policy.** Default is no network. If you open it, review the policy for your cluster; the sandbox isolates code, it does not replace approvals.
