# Entropi

A strict, headless core for human + agent work. State lives in the core, never in a UI.

```
src/core        domain + rules. Imports only itself and node:*. (enforced by test/boundaries.test.ts)
  types.ts      Realm, Actor, WorkItem, ExternalRef, DecisionRequest, AttentionItem, ActivityEvent, Presence
  core.ts       all mutations: realm-scoped, actor-checked, event + projection in one transaction
  optchat.ts    infinite memory tree, a rebuildable derivative of the runtime transcript
  ports.ts      EntropiSource (external truth), TranscriptSource (history for OptChat)
src/adapters    the only place that may import Pi / workflow engines / review systems
  pi/           PiTranscript: full history via Storage.scanEntries (not the live snapshot)
```

Rules the core enforces: no cross-realm reads/writes; every mutation names a member actor; events are append-only
(DB triggers); decisions idempotent per key, first decision wins, authority + separation of duties checked, an away
human (Echo) can never decide; attention is derived from state, never written by clients.

Run with Node >= 22.19: `npm install && npm test`.
