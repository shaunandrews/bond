# Step 4 — Background-agent visibility and control

Continue from the hardened worker. Build the product surface for work that outlives a turn.

## Build

- Add a persistent ambient indicator in conversation chrome while one or more agent runs are active; it must be distinct from per-turn tool activity.
- Add `meta/agent-run` transcript cards that stream concise progress, settle into completion/failure/question states, and link to the draft PR where present.
- Build a Tasks panel showing active/recent runs, status, latest event, elapsed time, workspace/branch, PR state, concise event log, and controls for cancel, answer, discard, and open PR.
- Ensure reconnect/reload reconciliation restores active cards/panel state from the durable store.
- Implement accessible keyboard navigation, mobile/narrow layouts, and non-disruptive notification behavior.
- Add tray notifications only for completion, failure, or needs-input while the app is unfocused.

## Constraints

Do not merge/apply code from the UI. GitHub remains the review/merge surface. Keep raw command logs collapsed and redacted by default.

## Tests

Cover multiple active runs, reconnect, completion during an active user turn, question interaction, cancellation, panel/card consistency, and narrow/mobile rendering.

Commit logical units and include screenshots or a short visual test report.
