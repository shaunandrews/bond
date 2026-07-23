# Step 3 — Resilience and operational controls

Continue from the prior step. Harden the job system before expanding its product surface.

## Build

- Finalize validated state transitions including `interrupted`; persist event before broadcasting snapshot.
- Add per-run cost/token budget, high but finite step and wall-clock backstops, disk quota, subprocess cap, command-output cap, and repeated-action/result loop detection.
- Add persisted agent-budget presets, leaving the resolver able to accept later per-run overrides. Bond-owned hard ceilings always clamp configured or requested values. A dense settings UI is out of scope.
- Classify failures: no retry for validation/auth/policy; bounded retry with jitter for transient failures; preserve worktree and useful diagnostics for all terminal states.
- Make daemon restart recovery automatic and idempotent: create a fresh session from brief, workspace/base SHA, checkpoint summary, last completed action, and pending checks. Never attempt to revive a dead child process.
- Add `bond agent status`, `list`, `logs`, `cancel`, `answer`, `discard` CLI commands backed by the same persisted APIs.
- Preserve a compact redacted run summary, final report, and branch/PR provenance indefinitely.
- Retain raw event payloads independently for 30 days by default, configurable to 7, 30, 90 days, or forever. Enforce a configurable total raw-log disk budget by evicting the oldest terminal-run payloads first. Expiry must never delete the run row or provenance.
- Retain managed worktrees independently and never discard unresolved or unpublished changes.
- Redact secrets from durable events, logs, completion cards, and CLI output.

## Tests

Fault-inject daemon death during model work and subprocess work, cancellation races, cap exhaustion, repeated loop detection, transient retry, duplicate resume, concurrent answer attempts, CLI parity, summary permanence, raw-log expiry/disk eviction, and worktree retention safety.

Do not build the full Tasks UI or merge/update flow yet. Commit logical units and report default limits plus any settings that should be user-configurable.
