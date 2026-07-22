# Plan 03 implementation map

Plan 03 continues from the published GitHub-handoff commits already present on
this branch. It does not add Tasks UI, merge detection, pull/apply, app launch,
or daemon restart behavior.

## Durable execution hardening

- Add explicit failure classes and bounded transient retry scheduling to the
  existing serialized worker/state machine. Validation, auth, permission,
  policy, cancellation, and resource-limit failures never retry.
- Persist attempt/retry timing in `agent_runs`; retain append-only events as the
  ordering truth. Startup requeues interrupted and due-retry runs idempotently.
- Strengthen checkpoint envelopes around model and subprocess boundaries; a
  recovered run always starts a new session and never revives an old PID.
- Centralize secret redaction before any durable event, checkpoint, error,
  completion-card, or CLI representation is written.

## Operations and retention

- Add agent-run RPCs and `bond agent` CLI commands for status/list/logs/cancel,
  answer, and discard.
- Add a conservative retention sweep for old terminal runs/worktrees. Never
  delete unresolved questions, retained unpublished changes, active/parked
  runs, or a published run whose workspace has not already been discarded.
- Keep run history durable by pruning only eligible discarded terminal rows;
  foreign-key cascades remove their event/question/publication children.

## Tests and commits

1. Retry/recovery/redaction and cap fault injection.
2. Retention safety and CLI/RPC parity.
3. Full typecheck, test, design-system check, CLI/daemon/web production build.
