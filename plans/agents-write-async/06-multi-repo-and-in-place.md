# Step 6 — Registered repositories and trusted in-place runs

Generalize the workspace contract from an implicit Bond checkout to an explicit registered repository identity. A registration fixes its canonical local root, base branch, allowed path prefixes, GitHub owner/name + remote mapping, command profile, acceptance checks, credential reference, and whether trusted in-place work is permitted.

Dispatch requires an explicit confirmed repository id. Worktrees remain the default and are unique per run. In-place is opt-in per trusted repository and requires a second per-dispatch confirmation plus a clean expected-branch checkout. Runtime path and policy checks are bound to the immutable repository snapshot on the run, so a run cannot cross repositories or inherit later config changes.

