# Phase 1 local Mathis implementation map

This tranche preserves the Phase 0 durable worker and stops before every live
GitHub/apply surface. It is split into three commits.

## 1. Managed worktree layer

- Add the opt-in `workspace: read-only | write` agent setting and bundled
  Mathis definition; Felix and Q retain the default `read-only` setting.
- Extend the durable workspace descriptor with the configured Bond repo root,
  base ref/SHA, managed branch, worktree path, and retention state.
- A single workspace manager creates/inspects/retains/discards worktrees using
  argv-only trusted git calls. It never touches the daemon checkout and never
  pushes or talks to a remote.
- Tests use temporary local repositories and prove containment, retention, and
  explicit discard cleanup.

## 2. Command and policy layer

- Add worktree-scoped write/edit plus a custom argv-only command tool.
- Pre-tool containment blocks all file-tool paths outside the managed
  worktree and protects `.git`.
- The command runner forces cwd, supplies a scrubbed explicit environment,
  owns a detached process group, kills that group on cancellation, and caps
  output/subprocesses/disk use.
- A versioned allowlist covers normal local Bond checks/builds/commits;
  daemon/app lifecycle, process killing, remote/system writes, shells, and
  path escapes are hard-denied. Unknown argv is never executed.

## 3. Park/resume layer

- Persist run-scoped questions and exact per-run argv grants. A novel command
  records argv/reason/checkpoint, aborts the current Pi session, and transitions
  the run to `needs-input`.
- Approval grants only that exact argv fingerprint and starts a replacement Pi
  session against the same retained worktree and checkpoint. Denial terminates
  as a policy failure. Boot recovery resumes approved parked runs without
  recreating their worktrees.
- `dispatch_agent` requires an explicit confirmation flag for Mathis's
  immutable brief. `check_agent` returns questions; a small answer tool/RPC
  supplies the conversational approval path without a Tasks UI.
- Resource guard hooks record steps/action-result fingerprints and enforce
  conservative wall-clock, output, disk, subprocess, step, token/cost seams.

## Parked publishing boundary

A no-op publishing interface may describe a future checked branch handoff, but
this tranche has no implementation that reads credentials, invokes `gh`, uses
network git operations, pushes, opens PRs, posts review comments, merges,
pulls, launches the app, or restarts the daemon.
