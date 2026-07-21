# `ask_user_question` — Implementation Plan

> Written from a codebase audit + external research (Claude Agent SDK `AskUserQuestion`, Pi's `question.ts`/`questionnaire.ts` examples, the community `HamdiMaz/AskUserQuestion` Pi extension, Spring AI's `AskUserQuestionTool`). Ready for Sonnet to execute top to bottom.

## What this is

A first-class Bond agent tool that pauses a turn, shows one structured question with numbered options in the transcript, and resumes the same turn with a typed answer. Renders in the desktop app, the mobile web client, and Quick Chat; answerable from the CLI.

## The one big decision

**Clone the approval pipeline exactly.** Bond already has a working "park a promise in the daemon, stream a prompt chunk, persist it into the turn activity row, resolve it over RPC, mirror the resolution to every client" path. Every requirement in the brief — reconnect replay, multi-device answering, cancellation safety — is already solved there. Do not invent a second mechanism.

The only real departure: the response payload is a typed `QuestionAnswer` instead of a boolean, and the composer becomes a second input path.

### Why not Pi's `ctx.ui`

`node_modules/@earendil-works/pi-coding-agent/examples/extensions/question.ts` and the community `AskUserQuestion` extension both bail with an error unless `ctx.mode === "tui"` and stdin/stdout are TTYs. Bond runs Pi inside the daemon with no terminal. Bond owns the UI; the tool must park a promise the way `requestApproval` does (`src/daemon/pi/runtime.ts:62`). They're still useful as prior art for schema shape and result text wording.

---

## Scope calls (recommendations, flagged for Shaun)

| Question | Decision | Why |
|---|---|---|
| One question or 1–4 per call? | **One.** | The brief says one. Number keys stay unambiguous, the card stays small on a phone, "one pending question at a time" becomes structural rather than enforced. Batching is a later protocol bump. |
| `multiSelect`? | **Not in v1.** | Not in the brief. It complicates number-key selection and the composer-answer semantics. Add later behind the same chunk with a `multiSelect` flag. |
| Who mints option IDs? | **The daemon.** | The brief wants stable IDs + display numbers, but models are unreliable bookkeepers. The tool schema takes `label` + `description` only; the daemon assigns `id = "<questionId>:<index>"` and `number = index + 1`. |
| Does a question block queued messages? | **Active turn only.** | There's a client-side queue (`useChat.ts:512`). The intercept happens in `submit()` *before* the queue branch, so a message typed while a question is pending becomes the answer and never reaches the queue. Already-queued messages stay queued and drain normally after the turn ends. |
| Can another device answer? | **Yes, first answer wins.** | `resolveQuestion` returns `false` for an unknown id (already resolved); the losing client flips its card via the `question_resolved` broadcast. Identical to approvals (`server.ts:417`). |
| Timeout? | **None.** | Claude Code's 60s is wrong for a phone. The question resolves on turn abort, session cancel, data-dir swap, and daemon shutdown — all already wired through `clearTurnApprovals`. A question left overnight costs one parked promise. If a timeout is ever wanted, make it ≥30 min and resolve as `cancelled`, never as an answer. |

---

## Step 1 — Shared contract

### 1a. `src/shared/questions.ts` (new)

```ts
export interface QuestionOption {
  id: string          // "<questionId>:<index>" — daemon-minted, stable
  number: number      // 1-based display number
  label: string
  description: string
}

export type QuestionAnswer =
  | { kind: 'option'; optionId: string; label: string; number: number }
  | { kind: 'custom'; text: string }
  | { kind: 'cancelled' }

export interface PendingQuestion {
  questionId: string
  turnId: string
  question: string
  header?: string
  options: QuestionOption[]
}
```

### 1b. `src/shared/stream.ts`

Add two chunks to `BondStreamChunk`:

```ts
/** The agent asked a structured question and is parked until it's answered. */
| { kind: 'user_question'; questionId: string; question: string; header?: string; options: QuestionOption[] }
/** A pending question was answered (possibly by another client or the CLI). */
| { kind: 'question_resolved'; questionId: string; answer: QuestionAnswer }
```

### 1c. `src/shared/rpc-schema.ts`

```ts
'bond.questionResponse': { params: { questionId: string; answer: QuestionAnswer }; result: { ok: true } }
'question.pending':      { params: undefined; result: PendingQuestion | null }
```

Add both to `RPC_METHOD_NAMES` (near `'bond.approvalResponse'` at line 412).

### 1d. `src/shared/bond-surface.ts`

Add to `buildDaemonSurface` beside `respondToApproval` (line 47) — pure daemon proxies, so desktop, web shim, and CLI all get them for free:

```ts
answerQuestion: (questionId: string, answer: QuestionAnswer) =>
  invoke('bond.questionResponse', { questionId, answer }),
pendingQuestion: () => invoke('question.pending', undefined),
```

### 1e. `src/shared/client.ts`

Add `answerQuestion(questionId, answer)` mirroring `respondToApproval` (line 225).

### 1f. `src/shared/protocol.ts`

**Bump `PROTOCOL_VERSION` (4 → 5).** Strictly, new chunk kinds are additive (the renderer switch has no `default`, so old clients ignore unknown kinds) and a new RPC method only fails if called. But a new client calling `bond.questionResponse` against an old daemon gets a method-not-found mid-turn with a parked promise on the other side — exactly the failure mode the version gate exists to prevent. Bump it; the web client's `mismatch` banner (`web/client.ts:136`) then parks cleanly instead of half-working. Also add a line to the numbered flow comment at the top (item 3 documents the approval round-trip; add item for the question round-trip).

---

## Step 2 — Daemon registry

### `src/daemon/questions.ts` (new)

A near-verbatim clone of `src/daemon/approvals.ts` (44 lines — read it first). Same id-space discipline: `questionId` resolves, `turnId` bulk-clears.

```ts
export function registerQuestion(questionId: string, turnId: string, snapshot: PendingQuestion): Promise<QuestionAnswer>
export function resolveQuestion(questionId: string, answer: QuestionAnswer): boolean
export function clearTurnQuestions(turnId: string): void   // resolves each as { kind: 'cancelled' }
export function currentPendingQuestion(): PendingQuestion | null   // for question.pending / CLI
export function pendingQuestionTurnIds(): string[]         // introspection/tests
```

Store the `PendingQuestion` snapshot alongside the resolver so `question.pending` can serve the CLI without touching the transcript.

**Test:** `src/daemon/questions.test.ts` — resolve by id, unknown id returns false, double-resolve returns false the second time, `clearTurnQuestions` resolves as cancelled and only for the matching turn.

---

## Step 3 — The Pi tool

### `src/daemon/questions/tools.ts` (new)

Model it on `src/daemon/web/tools.ts:89` (`registerWebTools`) — that's Bond's canonical `pi.registerTool` shape.

```ts
export const QUESTION_TOOL_NAMES = ['ask_user_question']

export interface QuestionToolOptions {
  turnId: string
  onChunk: (chunk: BondStreamChunk) => void
  abortSignal: AbortSignal
}

export function createQuestionExtensionFactory(options: QuestionToolOptions) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'ask_user_question',
      label: 'Ask User Question',
      executionMode: 'sequential',   // must not race other tool calls
      description: 'Ask the user one multiple-choice question and wait for their answer. Use when a decision is genuinely the user\'s to make and you cannot resolve it from the request, the code, or a sensible default.',
      promptSnippet: 'Ask the user one structured multiple-choice question and wait for the answer',
      promptGuidelines: [
        'Use ask_user_question only when the answer changes what you do next — never for choices with an obvious default or facts you can look up yourself.',
        'Give ask_user_question 2-4 options. Each option needs a short label and a description that names the trade-off.',
        'Put the recommended option first and suffix its label with "(Recommended)".',
        'Never add an "Other" option to ask_user_question — the user can always type a custom answer.',
        'Ask at most one ask_user_question per turn; if the user dismisses it, proceed with your best judgment instead of asking again.',
      ],
      parameters: Type.Object({
        question: Type.String({ description: 'The full question, ending in "?"' }),
        header: Type.Optional(Type.String({ description: 'Short chip label, 12 chars max' })),
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: '1-5 word display text' }),
            description: Type.String({ description: 'What this choice means or implies' }),
          }),
          { minItems: 2, maxItems: 6, description: 'Choices for the user' },
        ),
      }),
      async execute(_toolCallId, params, signal) { /* see below */ },
    })
  }
}
```

`execute` body:

1. `const questionId = randomUUID()`
2. Build `options` with daemon-minted `id`/`number`.
3. `options.onChunk({ kind: 'user_question', questionId, question, header, options })`
4. `const answer = await registerQuestion(questionId, turnId, snapshot)` — but race it against abort:
   ```ts
   const onAbort = () => resolveQuestion(questionId, { kind: 'cancelled' })
   signal?.addEventListener('abort', onAbort, { once: true })
   try { answer = await promise } finally { signal?.removeEventListener('abort', onAbort) }
   ```
   (Defence in depth — `clearTurnQuestions` in step 4 is the primary path.)
5. Return result text the model can act on:
   - option → `` `User selected option ${number}: ${label} — ${description}` ``
   - custom → `` `User wrote a custom answer: ${text}` ``
   - cancelled → `User dismissed the question without answering. Do not ask again — proceed with your best judgment or ask in plain prose.`
   
   Plus `details: answer` for rendering. Never `throw` — a dismissal is an answer, not a tool failure.

**Test:** `src/daemon/questions/tools.test.ts` — emits the chunk with numbered options, resolves with each answer kind, produces the right result text, aborts cleanly on signal. Mock `pi` as `{ registerTool: vi.fn() }` (see `src/daemon/onboarding.test.ts:191` for the pattern).

---

## Step 4 — Wire into the runtime

All in `src/daemon/pi/runtime.ts`:

1. Import `createQuestionExtensionFactory, QUESTION_TOOL_NAMES` and add the factory to `extensionFactories` (line 382) with `{ turnId: options.turnId, onChunk: options.onChunk, abortSignal: options.abortSignal }`.
2. `toolsForEditMode` (line 325): append `...QUESTION_TOOL_NAMES` to the returned array unconditionally. Asking a question touches no workspace files, so it stays available in `readonly` and `scoped` — same reasoning as the web tools (comment at line 310).
3. `REQUIRED_BOND_TOOL_NAMES` (line 336): add `...QUESTION_TOOL_NAMES`. It's Bond-owned; a silent registration failure must kill the turn.
4. **Cancellation — grep `clearTurnApprovals` and add `clearTurnQuestions(turnId)` at every single call site.** Currently five:
   - `runtime.ts:489` (abort listener)
   - `runtime.ts:518` (finally)
   - `turns.ts:237` (query_end)
   - `turns.ts:246` (startup failure)
   - `turns.ts:259` (`cancelActiveTurn`) and `turns.ts:273` (`settleTurns`)
   
   Missing one is how you get a blocked promise.

---

## Step 5 — Daemon RPC

`src/daemon/server.ts`, directly below `'bond.approvalResponse'` (line 408):

```ts
'bond.questionResponse': (params) => {
  const p = raw(params)
  const questionId = getStringParam(p, 'questionId')
  if (!questionId) throw new RpcError(RPC_INVALID_PARAMS, 'questionId is required')
  const answer = parseQuestionAnswer(p.answer)   // validate the union; throw RPC_INVALID_PARAMS on garbage
  resolveQuestion(questionId, answer)
  broadcastChunk(undefined, { kind: 'question_resolved', questionId, answer })
  return { ok: true }
},

'question.pending': () => currentPendingQuestion(),
```

Write `parseQuestionAnswer` in `src/shared/questions.ts` so the CLI and daemon share one validator. (Existing CLI subcommands mirror daemon types locally rather than importing shared — `src/cli/mcp.ts:37-60`. Importing from `shared/` is fine here since esbuild bundles it, and one validator beats two.) An unknown `questionId` still broadcasts and returns `{ ok: true }` — same forgiving shape as approvals; the broadcast is what un-sticks a stale card on another device.

---

## Step 6 — Activity model (this is what gives you replay for free)

Pending approvals are **not** replayed by the daemon — clients reconstruct them from persisted activity rows (`useChat.ts:139`). Questions must work the same way.

### `src/renderer/types/activity.ts`

Add to `TurnActivityEvent`:

```ts
| { id: string; type: 'question'; label: string; ts: number; endTs?: number;
    questionId: string; question: string; header?: string; options: QuestionOption[];
    status: 'pending' | 'answered' | 'cancelled'; answer?: QuestionAnswer }
```

Add `'awaiting_question'` to `TurnActivityStatus`.

**Then grep the whole repo for `'awaiting_approval'` and add `'awaiting_question'` beside it everywhere.** Known sites:

- `useChat.ts:209` (resume/reconcile), `:285` (post-resolution status reset), `:436` (`adoptLiveTurnFromTranscript` — without this a reload mid-turn drops every remaining chunk *including* `query_end`)
- **`src/daemon/transcript.ts:400` `LIVE_ACTIVITY_STATUSES`** — this is the daemon-side list the stale-write guard (`rejectStaleWrite`, :329) checks. Miss it and a client can regress a finalized row.

### 6b. Daemon-side finalize sweep — `src/daemon/transcript.ts:409-427`

This is the piece that makes daemon crashes safe, and it is easy to miss:

```ts
// finalizeActivityMessage() already does this for approvals at :422
if (evt.type === 'approval' && evt.status === 'pending') evt.status = 'cancelled'
```

Add the same line for `evt.type === 'question'`. `completeTurn()` (:429) calls it on every turn end, and `reconcileInterruptedTurns()` (:463) runs it at daemon startup over every `queued`/`running` turn — so a hard daemon crash cleans up persisted pending questions for free. Skip this and a killed daemon leaves a permanently un-answerable card in the transcript.

---

## Step 7 — `useChat.ts`

1. **Chunk allowlist:** add `'user_question'` to the `TURN_SCOPED_CHUNKS` set (`:102-106`) so a straggler from a cancelled turn can't mint an orphan question. **Do not add `'question_resolved'`** — like `turn_start`/`approval_resolved`/`edit_mode_changed`, it is cross-turn by design.
2. **`case 'user_question'`** in the chunk switch, modeled on `'tool_approval'` (line 385):
   - dedupe by `questionId` (idempotent — the same chunk can arrive twice)
   - call `finalizeOpenActivityEvents(data)` first, as the approval case does
   - `data.status = 'awaiting_question'`, `data.expanded = true`
   - push a `question` event with `status: 'pending'`
3. **`question_resolved` handler**, modeled on `approval_resolved` (line 275). **It must sit above the turnId-ownership guard at line 301**, next to the other cross-turn handlers — below it, a resolution arriving for a turn this client doesn't own gets dropped and the card stays stuck. Find the event, set `status`/`answer`/`endTs`, bump `activityRevision`, and if no pending question remains and status is `awaiting_question`, set it back to `'working'`.
4. **`cancelPendingQuestions(data, end)`** beside `cancelPendingApprovals` (line 238), called from the same three places (error path line 409, turn-end path line 319, and the reconcile path).
5. **`pendingQuestion` computed** — clone `pendingApprovals` (line 139) but return the *single* most recent pending question (or `null`), carrying `activityMessageId`.
6. **`answerQuestion(questionId, answer)`** — clone `respondToApproval` (line 553): call `deps.answerQuestion`, then mutate the event, bump `activityRevision`, mark dirty, `upsertMessage`.
7. **Composer intercept in `submit()` — the important one.** Insert immediately after the `ensureGlobalSubscription()` await (line 509) and **before** the `if (busy.value)` queue branch (line 511):
   ```ts
   const q = pendingQuestion.value
   if (q && trimmed && !images?.length) {
     await answerQuestion(q.questionId, { kind: 'custom', text: trimmed })
     return
   }
   ```
   Images alongside text fall through to the queue — an image is not an answer to a multiple-choice question.
8. Add `answerQuestion` to `ChatDeps` (interface at line 25) and export `pendingQuestion` + `answerQuestion` from the return object (lines 707/720).

**Test:** extend `useChat.test.ts` — question chunk creates a pending event; `question_resolved` flips it; composer submit while pending resolves as custom and does **not** queue or start a turn; a turn error cancels pending questions; a chunk with an unowned `turnId` is dropped.

---

## Step 8 — `QuestionPrompt.vue`

New component, `src/renderer/components/QuestionPrompt.vue`. Read `ApprovalPrompt.vue` first — match its visual language (accent border, `color-mix` accent-tinted surface, `--radius-lg`, `--shadow-sm`) but stack vertically since options need room.

**Props:** `questionId: string`, `question: string`, `header?: string`, `options: QuestionOption[]`
**Emits:** `answer(questionId: string, answer: QuestionAnswer)`

**Markup:**
- Root `<div class="question-prompt" role="group" :aria-labelledby="titleId" tabindex="-1">`
- Optional header chip (`BondText size="xs" weight="semibold" color="accent"`)
- Question text (`BondText size="sm"`) with `:id="titleId"`
- One `<button>` per option: a number badge, `BondText size="sm" weight="medium"` label, `BondText size="xs" color="muted"` description. `:aria-label="`Option ${o.number}: ${o.label}. ${o.description}`"`, `:aria-keyshortcuts="String(o.number)"`.
- A muted footer hint: `Press 1–{{ options.length }}, or type your own answer below.`
- A dismiss affordance (small `PhX` ghost button, `v-tooltip="'Dismiss'"`) emitting `{ kind: 'cancelled' }`.

**Keyboard:**
- Auto-focus the root on mount (`onMounted(() => rootEl.value?.focus())`) so number keys work immediately without stealing text input.
- A `window` `keydown` listener registered on mount, removed on unmount:
  ```ts
  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'Escape') { emit('answer', props.questionId, { kind: 'cancelled' }); return }
    const n = Number(e.key)
    if (!Number.isInteger(n) || n < 1 || n > Math.min(9, props.options.length)) return
    e.preventDefault()
    const o = props.options[n - 1]
    emit('answer', props.questionId, { kind: 'option', optionId: o.id, label: o.label, number: o.number })
  }
  ```
  The input/textarea guard is what keeps the composer usable — typing "2" into the composer must insert a "2".
- Options are real `<button>`s, so Tab/Enter work natively.

**Use existing primitives only** — `BondText`, `BondButton`, design tokens. No raw `<p>`/hardcoded colors.

**Test:** `QuestionPrompt.test.ts` — click emits the right option payload; `1`/`2` keydown emits; keydown from inside a textarea does not emit; `Escape` emits cancelled; aria-labels present.

---

## Step 9 — Mount it on all three surfaces

Identical treatment in each — stack it in the same slot as `ApprovalPrompt`:

- `src/renderer/App.vue:443` — add a `<QuestionPrompt v-if="chat.pendingQuestion.value" … @answer="chat.answerQuestion" />` beside the approval stack.
- `src/renderer/web/WebApp.vue:232` — same.
- `src/renderer/components/QuickChat.vue:130` — same (this surface is easy to miss; it already handles approvals).

Also render questions inside the timeline: `TurnActivity.vue` gets a `<template v-else-if="evt.type === 'question'">` branch beside the approval one (`:137-145`), showing the question and the chosen answer (`✓ 2. Balanced`, `✎ "custom text"`, or a muted `Dismissed`).

**Read-only in the timeline** — unlike approvals, do *not* put live buttons there. The stacked card above the composer is the single actionable surface, which keeps the number-key handler unambiguous and avoids a second `@answer` emit chain through `MessageBubble`. Add `'question'` to `hasDetail` (`:68`) and `active`/`approvalPending`-style status handling (`:18`, `:40` → `'Question'`).

**Composer placeholder:** while `pendingQuestion` is set, App.vue's `composerPlaceholder` should read something like `Pick an option above, or type your own answer…`. `ChatInput` already takes a `placeholder` prop (App.vue:466).

---

## Step 10 — CLI

`src/cli/ask.ts` (new), modeled on `src/cli/soul.ts`. Register in `bin/bond` beside the other `out/cli/*.js` entries (lines 344-380) and in the `build:cli` esbuild entry list.

```
bond ask                  Show the pending question; prompt interactively if a TTY
bond ask 2                Answer with option 2
bond ask --text "..."     Answer with custom text
bond ask --cancel         Dismiss the question
bond ask --json           Print the pending question as JSON and exit (never prompts)
```

Behavior:
- `question.pending` returns `null` → print `No pending question.` and **exit 0**.
- Not a TTY (`!process.stdin.isTTY`) and no explicit answer arg → print the JSON payload and exit 0. **Never block.** This is the "clear unsupported or pending status rather than hanging" requirement.
- TTY, no arg → print the question, numbered options with descriptions, then `readline` one line. A bare integer in range selects that option; anything else is sent as `{ kind: 'custom', text }`; empty input or Ctrl-C sends `{ kind: 'cancelled' }`.
- Send via `bond.questionResponse`, print a confirmation, close the socket.

Deliberately **not** building a CLI chat client — `bin/bond` has no chat today and the brief doesn't ask for one.

**Test:** `src/cli/ask-helpers.ts` + `ask-helpers.test.ts` for the pure logic (parse an answer line against an option list, format the question block), following the `library-helpers.ts` split so tests don't trigger `main()` on import.

---

## Step 11 — Docs + verification

1. **`CLAUDE.md`** — add `questions.ts` and `questions/tools.ts` to the daemon table, `QuestionPrompt.vue` to the Components section (props/events), `user_question`/`question_resolved` to the stream chunk notes, `bond ask` to the CLI list, and the `question` activity event to the Message Types section.
2. **`DevComponents.vue`** — add a live `QuestionPrompt` preview with props/events docs (required by CLAUDE.md whenever a component is added).
3. `npx vue-tsc --noEmit`
4. `npm run test:run`
5. `bin/bond rebuild daemon` (daemon + shared changed), `npm run build:web` (web client changed), then `npm run dev`.

---

## Manual acceptance pass

Run each; all six are in the brief's acceptance criteria.

1. Ask Bond something ambiguous → card renders in the desktop transcript with numbered options.
2. Click option 2 → turn resumes, model acknowledges the choice.
3. Repeat, answer by pressing `2` → same result. Then repeat and type "actually, neither — do X" in the composer → resolves as custom, no new turn started, no queued message.
4. Trigger a question, reload the window → card is still there and still answerable. Trigger one, answer on the phone → desktop card flips to answered.
5. Trigger a question, hit Stop → card shows cancelled, no parked promise (`pendingQuestionTurnIds()` empty), next send works.
6. Trigger a bash approval in scoped mode → approvals still behave exactly as before.

---

## Sources

- [Handle approvals and user input — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/user-input)
- [HamdiMaz/AskUserQuestion — Claude Code-style AskUserQuestion for the pi agent](https://github.com/HamdiMaz/AskUserQuestion)
- [Spring AI Agentic Patterns: AskUserQuestionTool](https://spring.io/blog/2026/01/16/spring-ai-ask-user-question-tool/)
- [paulp-o/ask-user-questions-mcp — browser UI for pending questions](https://github.com/paulp-o/ask-user-questions-mcp)
- Local: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (§`pi.registerTool`, §`ctx.mode`/`ctx.hasUI`), `examples/extensions/question.ts`, `examples/extensions/questionnaire.ts`
