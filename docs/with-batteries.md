# With batteries

The core is free: it has no opinion about which agent runtime, model, sandbox, UI or login you use. It only has ports. "With batteries" is the one opinionated assembly that works out of the box. It is what `npm run demo` and `deploy.sh` run.

## What is in the box

| Battery | What it is | Port it plugs into |
|---|---|---|
| Agents | Pi Durable runtime (`src/adapters/pi`) | `AgentDispatcher` (+ optional `AgentControl` abilities) |
| Sandbox | Pi's `ExecutionEnv` running in rootless podman, or a pod in Kubernetes (`src/adapters/sandbox`) | `SandboxBackend`, handed to Pi as its execution environment |
| Memory | OptChat summary tree in its own SQLite file (`src/memory`) | `TranscriptSource` |
| UI | The wireframe UI in `public/`, over HTTP + SSE | the HTTP API (`src/http`) |
| Model | A local OpenAI-compatible endpoint or gateway | `Inference` (`src/adapters/pi/inference.ts`) |
| Login | A trusted proxy that sets a user header | `config.auth` (no login code inside Entropi, see [steering.md](steering.md)) |
| Outside world | A fake cluster for the demo | `EntropiSource` |

## The one recommended path

Locally: build the sandbox image once (`scripts/build-sandbox.sh`), point Entropi at your model and run it airgapped:

```sh
AIRGAPPED=true LOCAL_LLM_BASE_URL=http://localhost:11434/v1 LOCAL_LLM_MODEL=<model> npm run demo
```

In a cluster (k3s with Traefik): copy `.deploy.env.example` to `.deploy.env`, set `BASE_DOMAIN` and the model (the key is read from a file and ends up only in a cluster Secret), then `./deploy.sh`. It builds both images, creates the `entropi` and `entropi-sandboxes` namespaces (the sandbox one with default-deny network policy and a quota) and prints the URL. Nothing outside those two namespaces is touched.

One honest caveat: `deploy.sh` defaults to `AUTH_MODE=dev` (three demo logins), which is fine on a private network such as a tailnet and nowhere else. For real use put an authenticating proxy in front and set `AUTH_MODE=proxy`.

## Taking a battery out

- **Another agent runtime:** implement `AgentDispatcher` (take an outbox item, answer through the core's normal operations). Implement whichever `AgentControl` abilities you can (`stop`, `compact`, `memtree`, `usage`); the API and UI show only those. The scripted demo agents are such a runtime with no abilities.
- **No sandbox / another sandbox:** run with `SANDBOX_BACKEND=none` and agents get no coding tools, or write a `SandboxBackend` (podman and kube are two).
- **Another memory:** OptChat only reads history through `TranscriptSource`; drop it or replace it, the core never notices.
- **Another model or cloud:** any OpenAI-compatible URL, per agent with `AGENT_<HANDLE>_MODEL`. Cloud providers register only if their key is set and `AIRGAPPED` is off.
- **Another UI:** the HTTP API is the whole contract; the core knows no UI.
- **A real outside system:** write an `EntropiSource` (`observe`, `query`, `invoke`) and bridge it with `src/runtime/sources.ts`. The fake cluster is the reference for the shape.

`test/boundaries.test.ts` keeps this honest: the core imports nothing but itself, and adapters never import each other.

## To make this a production system you need

- **Real login.** A proper IdP and an authenticating proxy in front, roles mapped from it. Entropi deliberately has no login of its own.
- **Backups and migrations.** The state is SQLite files (core, Pi, memory, sandbox registry) on one volume. Nothing backs them up, and schema migrations are plain numbered steps with no rollback.
- **More than one node.** One process owns the SQLite files. There is no clustering, failover or horizontal scaling.
- **Real adapters.** The only source is a fake cluster. Your cluster, review system, CI and workflow engine need adapters, with their own credentials and least-privilege RBAC.
- **Pi Durable is experimental.** The version is pinned exactly; follow its releases, read the changelog before bumping and expect to touch `src/adapters/pi`.
- **Gateway limits and cost.** Rate limits, quotas and spend caps live in your gateway. Entropi reports quota and network errors plainly but does not meter or cap spend.
- **Sandbox network policy.** Default is no network. If you allow outbound, review the policy: the supplied one permits public 80/443 only and excludes private ranges, but it is yours to verify for your cluster. The sandbox is isolation for untrusted code, not a substitute for approvals on anything that changes real systems.
