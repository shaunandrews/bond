# Phase 6 implementation map

- Persisted repository registry with canonical identity, root/base/remote mapping, allowed paths, command/check profile, credential reference, and trusted-in-place flag.
- Workspace descriptors carry repository identity; run dispatch snapshots the selected repository contract.
- Worktree manager accepts registered roots while retaining unique run paths; in-place preflight proves clean checkout and expected branch.
- Command policy intersects the built-in hard denylist with the immutable per-repo command profile.
- RPC/Bond surface supports register/list/remove and explicit target selection fields at dispatch.
- Tests cover identity validation, wrong remote, cross-repo and allowed-path denial, concurrent worktrees, policy isolation, and in-place confirmation/dirty refusal.

Migration: synthesize the built-in `bond` registration from existing `agents.bondRepoRoot`/`agents.bondBaseRef` settings. Existing Bond-only dispatch remains compatible and resolves to that registration.
