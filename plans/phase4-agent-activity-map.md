# Plan 04 implementation map

## Durable card lifecycle

- Reuse `meta/agent-run` transcript rows and the existing idle-turn queue.
- Give each run one stable activity-card id; insert it only when the active user
  turn is idle, then update that row in place as durable run state changes.
- Render cards from the shared run store when online, with persisted card data
  as the reload/offline fallback.

## Renderer state and controls

- Add one shared `useAgentRuns` store backed by `agentruns.list/get` and
  `agent_run_changed`, with explicit reconnect reconciliation.
- Add a Tasks utility panel and conversation-chrome activity indicator. Reuse
  the existing panel group, toolbar, buttons, and external-link bridge.
- Keep command/event payloads collapsed by default. Cancel, answer, inspect,
  discard, and PR-open actions call the existing persisted APIs.

## Notifications and tests

- Main-process notifications are deduplicated by run/status and emitted only
  for `needs-input` or terminal transitions while the main window is unfocused.
- Cover store reconciliation, multiple active runs, card state parity,
  controls, accessibility, narrow CSS, and notification gating.
