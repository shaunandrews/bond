# Step 5 — Merge detection and safe Bond updates

GitHub remains the merge source of truth. Bond polls published run PRs, records merge detection idempotently, classifies the merged paths, and exposes an explicit update decision. It never auto-merges or destructively resets a checkout.

Risk tiers are deterministic: renderer-only changes may use the existing renderer reload path; daemon-only changes without protocol/schema/shared contracts require a controlled build/restart/reconnect; protocol, shared, schema, migration, or broad changes require a scheduled user action. Every local update first proves the configured Bond checkout is clean, on the expected branch, and fast-forwardable.

The update executor is dependency-injected so tests cover pull/build/restart/reconnect and failure recovery without restarting the development daemon. Active turns defer all update execution.

