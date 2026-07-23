# Phase 5 implementation map

- `shared/agent-runs.ts`: durable merge/update state and user-facing risk tier.
- `daemon/agents/async/schema.ts`, `store.ts`: one immutable run provenance row plus idempotent merge/update checkpoints and append-only events.
- `daemon/agents/async/merge-updates.ts`: scoped GitHub polling, deterministic path classification, checkout preflight, and injected update/recovery operations.
- `daemon/agents/async/service.ts`, `server.ts`, shared RPC/Bond surface: reconnect reconciliation and explicit scheduled update action.
- Renderer run card/Tasks view: merged risk and update state.
- Tests: duplicate polling, all tiers, dirty/wrong/non-FF checkout, active-turn deferral, build/restart/reconnect failures.

No live merge, pull, build, restart, or app launch is performed while implementing or testing this tranche.

