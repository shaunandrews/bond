# Review: Natural Language Todo Input

## Verdict: Conditional Approval

Ship it, but fix the architecture issue (#1) and the short-circuit logic (#3) first. The rest can be addressed during implementation.

---

## Strengths

- **Correctly identifies the inconsistency.** TodoView already uses `parseTodo` with AI; ProjectDetail creates raw literal todos. Unifying them is the right call.
- **Reuses existing infra.** Building on top of `createTodo()` rather than replacing the DB layer. Keeping `todo.parse` for the CLI. Good instinct.
- **Implementation order is correct.** Daemon first, then wire RPC, then update components one at a time. Each step is independently testable.
- **Identifies TodoEmbed as a third surface.** Easy to forget about embeds. The plan catches it.

---

## Issues

### 1. CRITICAL: Don't create server-side. Return structured data, let the client create.

The plan proposes `todo.createFromPrompt` as a single RPC that parses AND creates. This is wrong for several reasons:

- **Partial failure is invisible.** If 3 todos are parsed but `createTodo` fails on #2 (DB constraint, disk full, whatever), the client gets an error but 1 todo was already created. The client has no way to know what succeeded.
- **No preview/confirmation.** Right now you probably don't need it. But the moment someone types a paragraph and the AI splits it into 5 todos they didn't expect, they'll want to see what's about to be created before it's committed. Baking creation into the RPC closes that door permanently.
- **Undo is harder.** The plan's own open question admits this. If the client creates the todos, it knows every ID it just created and can batch-delete them. If the server creates them, the client has to parse the response to extract IDs, and there's a race with the `todoChanged` event refreshing the list.
- **Breaks the existing pattern.** TodoView currently does `parseTodo` then `createTodo` as two steps. The plan replaces a two-step pattern with a one-step pattern that's strictly less flexible.

**Suggestion:** Create `todo.parseFromPrompt` (not `createFromPrompt`). It returns `ParsedTodo[]` (an array, unlike the current single-object `todo.parse`). The client iterates and calls `createTodo` for each. This keeps the client in control, makes undo trivial, and enables a future confirmation step.

```ts
case 'todo.parseFromPrompt': {
  const prompt = getStringParam(p, 'prompt')
  const parsed = await parseTodosFromPrompt(prompt)
  return JSON.stringify(makeResponse(id, { todos: parsed }))
}
```

Client:
```ts
const { todos: parsed } = await window.bond.parseFromPrompt(raw)
const created = []
for (const p of parsed) {
  created.push(await window.bond.createTodo(p.title, p.notes, p.group, projectId))
}
// created[] has every ID for undo
```

Yes, this means multiple round-trips. Doesn't matter. We're already waiting 1-3s for AI. The sequential `createTodo` calls add <10ms total against SQLite.

### 2. HIGH: AI prompt needs more guardrails

The proposed system prompt is too vague. Specific problems:

- **No handling of non-todo input.** What happens when someone types "how's the weather" or "thanks"? The prompt says "you create todos from natural language" but doesn't tell the AI what to do when the input isn't a todo. It'll hallucinate a todo like "Check the weather forecast." Add: `If the input is not a task or action item, return an empty array [].`
- **No cap on array size.** Someone pastes a long meeting transcript, the AI returns 30 todos. Add: `Return at most 5 todos. If the input implies more, consolidate.`
- **Group values will be inconsistent.** The prompt says "1-2 word category (lowercase)" but doesn't tell the AI about existing groups. If the user has "frontend" todos and types something that could be "frontend" or "ui", the AI will pick randomly. Pass existing group names as context: `Existing groups: [frontend, backend, design]. Prefer these if applicable.`
- **No language handling.** If the user types in Spanish, does the AI return Spanish titles? Probably yes, which is fine. But the prompt should be explicit: `Preserve the user's language.`
- **JSON parsing is fragile.** The current `parseTodoInput` uses regex `\{[^}]+\}` to extract JSON. For an array response, you need different parsing. Haiku sometimes wraps JSON in markdown code blocks. Handle: strip ```json fences, parse the full response as JSON first, fall back to regex.

### 3. HIGH: Short-circuit logic is backwards

The plan says: skip AI for input <60 chars with no conjunctions. But consider:

- `refactor auth` (14 chars) — could benefit from AI adding notes about what to refactor
- `buy milk` (8 chars) — definitely doesn't need AI
- `review the PR for #1234 and update CHANGELOG and tag a release` (63 chars) — just over threshold, DOES need splitting

The char-length heuristic is not the right signal. The existing `parseTodoInput` uses it because it only extracts title/notes/group from a single input — there's no splitting concern. But the new feature's whole value is multi-todo splitting and enrichment.

**Suggestion:** Always send to AI. Haiku is fast (~500ms) and cheap. The short-circuit optimization saves at most half a second and loses the entire value prop of the feature. If latency is a concern, add the optimization later with telemetry showing which inputs the AI returns unchanged. For now, the only short-circuit should be: input is empty or whitespace-only.

If you absolutely must have a short-circuit, make it opt-in: if the user holds Shift+Enter to submit (or there's a "literal mode" toggle), skip AI and create a raw todo. This gives power users an escape hatch without guessing intent from char count.

### 4. MEDIUM: Three components, zero shared logic

The plan updates TodoView, ProjectDetail, and TodoEmbed with the same pattern: ref for text, ref for parsing state, async function that calls `createTodosFromPrompt`, clears input, refreshes list. That's copy-paste across 3 files.

**Suggestion:** Extract a composable:

```ts
// composables/useTodoPrompt.ts
export function useTodoPrompt(projectId?: Ref<string | undefined>) {
  const text = ref('')
  const parsing = ref(false)

  async function submit() {
    const raw = text.value.trim()
    if (!raw || parsing.value) return []
    parsing.value = true
    try {
      const { todos } = await window.bond.parseFromPrompt(raw)
      const created = []
      for (const t of todos) {
        created.push(await window.bond.createTodo(t.title, t.notes, t.group, projectId?.value))
      }
      text.value = ''
      return created
    } finally {
      parsing.value = false
    }
  }

  return { text, parsing, submit }
}
```

All three components consume this. Changes to the add-todo flow happen in one place.

### 5. MEDIUM: No error UX defined

The plan's "Polish" step says "test edge cases (empty results, API failures)" but doesn't specify what the user sees. Current `parseTodoInput` silently falls back to using the raw text. The new multi-todo version needs explicit decisions:

- **AI returns empty array:** Show the input text as a literal todo? Show an error? Do nothing? I'd say: create one todo with the literal text as title, and move on. Don't block the user.
- **AI call fails (network, timeout, rate limit):** Same — fall back to literal creation. Show a subtle inline warning "AI unavailable, created as-is" that fades after 3s. Never lose the user's input.
- **AI is slow (>3s):** The spinner already exists. But add a timeout — if Haiku hasn't responded in 8s, fall back to literal creation. Don't leave the user hanging.
- **AI returns malformed JSON:** Fall back to literal creation. Log the error for debugging.

The principle: **the input should always produce a todo.** AI enrichment is best-effort. The fallback is always "use the text as-is."

### 6. MEDIUM: Multi-todo splitting heuristic is hand-waved

"Don't over-split" is not an instruction the AI can follow reliably. The prompt example ("Review the PR and leave comments" = one todo) is good but insufficient.

**Suggestion:** Add 2-3 more examples to the system prompt as few-shot guidance:

```
Examples:
- "review the PR and leave comments" -> 1 todo (these are part of the same workflow)
- "review the PR for auth and also fix the typo on the landing page" -> 2 todos (unrelated tasks)
- "I need to update the docs, write tests, and deploy to staging" -> 3 todos (distinct actions)
- "set up CI/CD pipeline" -> 1 todo (even though it involves multiple steps)
```

Few-shot examples are worth more than rules for LLM prompts. The AI will pattern-match on these much better than on "don't over-split."

### 7. LOW: Plan mentions TodoEmbed but underspecifies it

The plan says "Wire it to `createTodosFromPrompt` too" for TodoEmbed, but TodoEmbed's add input is a minimal inline field inside chat messages. Adding AI parsing + spinner + multi-todo creation to an inline embed input is a different UX than the dedicated panels. Questions:

- Does the embed input need multi-line support (textarea)? Probably not — it's inline.
- Does it need the spinner? It currently has no loading state at all.
- What if the AI creates 3 todos from an embed input? They all appear in the embed's filtered view? What if the embed has a `group` filter and the AI assigns a different group?

**Suggestion:** For the embed, keep it simple — use the composable but always pass the embed's `projectId`/`group` as overrides so the AI's guesses don't cause todos to appear outside the embed's filter. Or: skip AI for embeds entirely for v1. Embeds are a secondary surface.

### 8. LOW: `todo.parse` becomes dead code on the client

The plan keeps `todo.parse` for the CLI but the renderer will stop using it. That's fine, but note it explicitly so no one wonders why it exists. Add a comment to the RPC handler.

---

## Recommendations

If I were rewriting this plan:

1. **Rename the RPC to `todo.parseFromPrompt`**, return `ParsedTodo[]`, don't create anything server-side. Client creates.
2. **Kill the short-circuit.** Always send to AI. Add a Shift+Enter escape hatch for literal creation.
3. **Extract `useTodoPrompt` composable** before touching any component. Then updating TodoView, ProjectDetail, and TodoEmbed is trivial.
4. **Add few-shot examples** to the system prompt. Add guardrails for non-todo input and array size cap.
5. **Define the fallback chain explicitly:** AI returns todos -> use them. AI returns empty -> literal todo. AI fails -> literal todo. AI times out (8s) -> literal todo. User should never lose input.
6. **Ship incrementally:**
   - **Phase 1:** New `parseFromPrompt` daemon function + RPC + composable + update TodoView only. This is the MVP. Test it for a few days.
   - **Phase 2:** Update ProjectDetail (input -> textarea, add spinner, use composable).
   - **Phase 3:** Update TodoEmbed (if it even needs AI — evaluate after phases 1-2).
   - **Phase 4 (later):** Preview/confirmation UI for multi-todo creation, batch undo, passing existing groups as context.

The plan is 80% there. The core idea is sound. Fix the architecture (parse vs create), harden the AI prompt, share the logic via composable, and ship it in two phases instead of one.
