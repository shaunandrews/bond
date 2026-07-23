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
- Resolve persisted conservative, standard, or extended budget presets into an
  immutable per-run cap contract. Keep an internal override seam for later
  dispatch support and clamp every value to Bond-owned hard ceilings.

## Operations and retention

- Add agent-run RPCs and `bond agent` CLI commands for status/list/logs/cancel,
  answer, and discard.
- Preserve terminal run rows, compact redacted summaries, final reports, and
  publication/workspace provenance indefinitely.
- Split raw event payloads from the append-only event envelope. Retain payloads
  for 30 days by default (7/30/90/forever are valid), then enforce a total
  payload budget by evicting oldest terminal-run logs first. Worktree cleanup
  remains independent and conservative around unpublished changes.

## Tests and commits

1. Retry/recovery/redaction and cap fault injection.
2. Retention safety and CLI/RPC parity.
3. Full typecheck, test, design-system check, CLI/daemon/web production build.
