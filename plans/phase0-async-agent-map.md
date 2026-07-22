# Phase 0 async-agent implementation map

Scope is limited to the durable read-only async spine. Existing `consult_agent`
behavior stays synchronous and unchanged; write tools, per-run worktrees,
GitHub/PR work, Q review comments, Tasks UI, and apply/publish flows are parked.

## Affected areas

- `src/shared/agent-runs.ts`, `stream.ts`, `rpc-schema.ts`, and `protocol.ts`:
  validated wire types for durable runs/events, reconnect listing,
  `agent_run_changed`, and the required protocol-version bump.
- `src/daemon/db.ts` and `agents/async/store.ts`: in-version `CREATE TABLE IF
  NOT EXISTS` migration for `agent_runs` and append-only `agent_run_events`;
  no `APP_SCHEMA_VERSION` bump or destructive cutover.
- `src/daemon/agents/async/{executor,worker,completion,service}.ts`: read-only
  execution adapter, concurrency-1 serialized worker, restart reconciliation,
  cancellation, completion insertion, and lifecycle wiring.
- `src/daemon/agents/tools.ts` and `pi/runtime.ts`: add non-blocking
  `dispatch_agent` and durable `check_agent`; retain `consult_agent` unchanged.
- `src/daemon/turns.ts`, `transcript.ts`, and `server.ts`: queue off-turn
  completion insertion until all user turns settle, broadcast run snapshots,
  start/stop the worker, and expose read/cancel RPC seams for reconciliation.
- `src/renderer/composables/useChat.ts`: refresh the persisted transcript when
  a completion-bearing run change arrives; reconnect already reloads it.

## Schema and state/event model

`agent_runs` stores the immutable dispatch contract (brief, paths, read-only
workspace descriptor/base SHA, allowed paths, agent/settings/definition
version, command-policy version, acceptance checks, resource caps, and a
unique idempotency key) plus the current snapshot/result/error and completion
message marker. `agent_run_events` uses a per-run sequence and database
triggers that reject UPDATE/DELETE, making it append-only.

Allowed states are `queued`, `preparing-workspace`, `running`, `needs-input`,
`succeeded`, `failed`, `cancelled`, and `interrupted`. Every transition is
validated in code and committed in one transaction that inserts the event
before updating the snapshot; broadcast happens only after commit. Startup
moves stranded `running`/`preparing-workspace` rows to `interrupted`, then the
worker re-enters them from their durable brief and transitions through a fresh
prepare/start checkpoint. Phase 0 never enters `needs-input`.

The worker owns one active `AbortController`, runs one job at a time, and
removes controller/state references in `finally`. Cancellation commits
`cancelled` before aborting the read-only Pi session. Terminal completion is a
structured `meta/agent-run` transcript row rendered by the existing minimal
meta card fallback; its insertion marker makes retries/restarts idempotent.

## Test plan

- Store/schema tests: immutable idempotent dispatch, append-only events, and
  invalid transition rejection.
- Tool tests: immediate dispatch response, duplicate idempotency behavior, and
  durable `check_agent` without changing synchronous consultation tests.
- Worker tests: concurrency 1, successful dispatch, restart recovery from a
  stranded running row, cancellation/abort cleanup, and no post-cancel success.
- Completion tests: off-turn insertion once, queueing during an active user
  turn, flush after settlement, and restart reconciliation of an uninjected
  terminal run.
- Run focused Vitest suites, full `npm run test:run`, `npm run typecheck`, and
  the repository's available lint/check script (there is currently no `lint`
  package script; `design-system:check` is the closest repository check).
