# Context Window Gauge

A visual indicator showing how much of the model's context window is consumed, displayed in the chat input toolbar and on operative detail views.

---

## Why

Long conversations and tool-heavy sessions silently approach the context limit. By the time the user notices degraded responses or hits an error, they've already lost quality. A gas-gauge metaphor — small, unobtrusive, changes color as it fills — gives at-a-glance awareness without cluttering the UI.

---

## How context works (what the SDK gives us)

The Claude Agent SDK reports token usage at two levels:

**Per-step** — each `SDKAssistantMessage` contains `message.message.usage`:
```ts
{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number | null
  cache_creation_input_tokens: number | null
}
```
The `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the **most recent** assistant message represents the total context consumed in that API call. This is the "fill level" of the context window right now.

Parallel tool calls produce multiple `SDKAssistantMessage`s with the same `message.message.id` and identical usage — deduplicate by ID.

**On completion** — `SDKResultMessage` includes:
- `total_cost_usd` — authoritative cost for the entire `query()` call
- `usage: NonNullableUsage` — cumulative tokens
- `modelUsage: Record<string, ModelUsage>` — per-model breakdown including:
  ```ts
  {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
    contextWindow: number    // <-- the denominator we need
    maxOutputTokens: number
  }
  ```

**Compaction** — the SDK emits `SDKCompactBoundaryMessage` (with `pre_tokens`) when it auto-summarizes the conversation to free up context. After compaction, the next assistant message's `input_tokens` drops. Our approach handles this naturally.

### Key insight

The gauge numerator is **not** a cumulative sum across the session. It's a point-in-time reading: "how much context did the model just consume?" This is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the latest assistant message. When context is compacted, the number drops. When a big tool result is added, it spikes. This accurately reflects the model's working memory.

---

## Architecture

### 1. Shared types

**`src/shared/stream.ts`** — add to the `BondStreamChunk` union:
```ts
| { kind: 'usage_update'; inputTokens: number; contextWindow: number; costUsd: number }
```

Where `inputTokens` is the total context consumed (input + cache read + cache creation) from the latest step. `contextWindow` is the model's limit. `costUsd` is cumulative cost for this query call.

**`src/shared/models.ts`** — no changes needed. Context window size comes from the SDK, not hardcoded.

### 2. Daemon — extract and emit usage

**`src/daemon/agent.ts`** — in the `for await (const message of q)` loop:

```ts
// Track last seen message ID to deduplicate parallel tool calls
let lastMessageId: string | null = null
let lastInputTokens = 0
let contextWindowLimit = 0  // Unknown until first result
let cumulativeCost = 0

// Inside the loop:
if (message.type === 'assistant' && message.message?.id !== lastMessageId) {
  lastMessageId = message.message.id
  const u = message.message.usage
  lastInputTokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)

  if (contextWindowLimit > 0) {
    onChunk({
      kind: 'usage_update',
      inputTokens: lastInputTokens,
      contextWindow: contextWindowLimit,
      costUsd: cumulativeCost
    })
  }
}

if (message.type === 'result') {
  cumulativeCost = message.total_cost_usd ?? 0

  // Extract contextWindow from modelUsage
  const models = message.modelUsage ?? {}
  const primary = Object.values(models)[0]
  if (primary?.contextWindow) {
    contextWindowLimit = primary.contextWindow
  }

  onChunk({
    kind: 'usage_update',
    inputTokens: lastInputTokens,
    contextWindow: contextWindowLimit,
    costUsd: cumulativeCost
  })
}
```

Note: the first `usage_update` with a known `contextWindow` arrives after the first `result` message. Before that, no gauge is shown. This avoids hardcoding model limits.

For resumed sessions: the first assistant message after resume reports full context size (including history), so the gauge works correctly without special handling.

### 3. Operatives — same extraction

**`src/daemon/operatives.ts`** — apply the same pattern in `runOperative()`:

- Track `lastInputTokens` and `contextWindowLimit` alongside existing `totalInputTokens` / `totalOutputTokens`
- Emit `usage_update` events via `storeEvent()` so the UI gets live updates
- On result, also use `message.total_cost_usd` instead of manually computing cost (fix existing bug where hardcoded `COST_PER_MTOK` rates don't account for cache discounts)
- Store `contextWindow` in the operative DB record (see schema migration below)

**`src/shared/operative.ts`** — add to `Operative` interface:
```ts
contextWindow?: number
```

**DB migration** — add column:
```sql
ALTER TABLE operatives ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0;
```

### 4. Renderer — ContextGauge component

**`src/renderer/components/ContextGauge.vue`**

Props:
```ts
{ used: number; limit: number; cost?: number }
```

Visual spec:
- Small ring/arc, 24px diameter, 3px stroke
- Sits to the left of the submit button in the ChatInput toolbar
- Hidden when `limit` is 0 (no data yet)
- Stroke color transitions through three zones:
  - **0–60%**: `var(--color-muted)` — everything's fine, barely noticeable
  - **60–80%**: `var(--color-accent)` — heads up
  - **80%+**: `var(--color-err)` — running low
- Smooth CSS transition on color and arc length
- When idle (between queries), the gauge dims slightly to indicate stale data
- On hover, tooltip positioned above (not below — it's near window edge):
  ```
  42k / 200k tokens (21%)
  Session cost: $0.12
  ```
- Tokens formatted with `k` suffix: `Math.round(n / 1000) + 'k'`

**`src/renderer/components/ChatInput.vue`** — add gauge to the right-side toolbar:
```html
<div class="flex items-center gap-s">
  <ContextGauge :used="contextUsage.inputTokens" :limit="contextUsage.contextWindow" :cost="contextUsage.costUsd" />
  <BondButton v-if="busy" ... />  <!-- Esc to stop -->
  <button ...><!-- Submit --></button>
</div>
```

New prop on ChatInput:
```ts
contextUsage: { inputTokens: number; contextWindow: number; costUsd: number }
```

**Chat composable / App.vue** — handle the new chunk kind:
```ts
const contextUsage = ref({ inputTokens: 0, contextWindow: 0, costUsd: 0 })

// In chunk handler:
case 'usage_update':
  contextUsage.value = {
    inputTokens: chunk.inputTokens,
    contextWindow: chunk.contextWindow,
    costUsd: chunk.costUsd
  }
  break
```

Reset `contextUsage` when switching sessions (but preserve it within a session across queries — the values carry over naturally since each new assistant message reports the full context).

**`src/renderer/components/OperativeDetail.vue`** — same `ContextGauge` component:
- For running operatives: update from `usage_update` events in the event stream
- For completed operatives: compute from stored `inputTokens`, `outputTokens`, `contextWindow`

### 5. Compaction awareness

When `SDKCompactBoundaryMessage` is received in `agent.ts`:
- The next assistant message's `input_tokens` will be lower — the gauge drops naturally
- Optionally emit a system-level chunk so the UI can show a subtle indicator that context was compacted (e.g., a small divider in the message stream: "Context summarized")

This is a nice-to-have for v1. The gauge itself works correctly without special compaction handling.

---

## Scope for v1

**In scope:**
- `ContextGauge.vue` reusable component
- Usage extraction in `agent.ts` for main chat
- Usage extraction in `operatives.ts` for operatives (+ fix cost calculation)
- `usage_update` chunk type in shared stream types
- ChatInput integration
- OperativeDetail integration
- DB migration for `context_window` on operatives table
- Tooltip with token count and cost

**Deferred:**
- Compaction UI indicator (divider in message stream)
- Per-model breakdown in tooltip
- Persisting session-level cost to the sessions table
- Token counting API for pre-flight estimates
- Customizable warning thresholds

---

## Open questions (resolved)

| Question | Resolution |
|----------|-----------|
| Cumulative sum vs. point-in-time? | Point-in-time: last assistant message's total input tokens |
| Include output tokens in numerator? | No — context window measures input capacity |
| Hardcode model limits? | No — wait for first `modelUsage.contextWindow` from result message |
| Multi-model queries? | Use the primary model's contextWindow (first entry in modelUsage) |
| Session resumption? | Handled naturally — resumed queries report full context size |

---

## References

- [Token counting — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Context windows — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Track cost and usage — Agent SDK](https://platform.claude.com/docs/en/agent-sdk/cost-tracking)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
