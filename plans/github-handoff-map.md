# GitHub handoff implementation map

This slice extends the retained Mathis worktree pipeline and does not use
ambient `gh`, credential helpers, or unrestricted GitHub operations.

## 1. Configuration and persistence

- Store only a fixed-repository configuration and Keychain reference in
  SQLite settings; the credential value remains in Bond's existing macOS
  Keychain store and never crosses a read RPC.
- Add one durable publication row per agent run. State changes also append to
  `agent_run_events`; retries reuse the same row and idempotency key.

## 2. Narrow publish service

- Validate a successful Mathis run, retained managed worktree, clean committed
  branch, declared checks, configured `origin`, and exact
  `shaunandrews/bond` remote before any write.
- Inject local-git and GitHub transports. The production transports expose only
  push-this-run-branch and find/create/update-draft-PR operations. Tests use
  fakes, so verification performs no network or remote git writes.

## 3. Q advisory handoff

- Classify touched paths deterministically. High-risk changes invoke a narrow
  read-only Q reviewer and create/update one marked advisory issue comment on
  the associated draft PR. Small renderer-only changes skip Q.
- Persist PR/Q URLs, failures, and events, then include them in the existing
  deferred completion card.

## Tests

Missing credential, repository/remote/branch/check validation, successful and
duplicate draft publication, transport failure, risk classification, Q comment
update, forbidden non-draft/foreign-PR operations, and completion rendering.
