# Memory Reliability — Why Bond Forgets, and How to Fix It

> **Revision 3** — 2026-07-21. Revision 1 was written by Opus after a five-hour session in which Bond's answer quality degraded until it could not resolve "Lets move on to 9." Revision 2 independently re-verified every measured claim against the live database, the Pi session JSONLs, and `~/.bond/daemon.log`; corrected two numbers and one framing; added Findings 6–9; and expanded the proposed work into an implementation-ready specification. Revision 3 is a second investigation pass over the memory *and context* systems: it adds Finding 10 (every new epoch re-observes the entire transcript from seq 1), Finding 11 (the context envelope is re-injected whole every turn and accumulates in session history), and Finding 12 (transcript/memory search misses by construction — including the recovered incident queries proving it), plus work items 3 and 6 and marker seeding in item 1. Numbers marked **[measured]** were reproduced against live data during the R2/R3 passes. **The failure is still live**: at R2 time the active epoch's observer marker was stuck at seq 832 while the transcript was at seq 867, with the newest daemon.log entries rejecting seqs 845–864 — the incident messages themselves currently unobservable.
>
> **STATUS — 2026-07-21, all seven items implemented.** Items 1–7 shipped in one pass (2,017 tests green, `vue-tsc` clean). Corrections found during implementation, recorded here because the findings above are otherwise unedited:
> - **Finding 12's memory-search claim was wrong.** `searchMemory` did NOT share the AND-only builder — `store.ts` had its own OR-joined builder all along. Memory retrieval never needed the OR ladder; it needed phrase support, which it got by delegating to the shared `fts.ts` builder. Transcript search is where AND-only actually hurt.
> - **`tool_execution_end` carries no `args`** (only `toolName`, `toolCallId`, `result`, `isError`). Item 2d's capture seam parks args from `tool_execution_start` by call id and consumes them at end.
> - **Item 7 Phase B was built alongside Phase A** rather than gated on the dogfooding day: with working memory now naming artifacts deterministically, the state snapshot costs nothing to render and is strictly better than the prose tail whether rollover fires weekly or hourly. Phase A's measurement still decides whether rollover frequency is acceptable — it just no longer gates the handoff.
> - The `memory.working` JSON gained three fields (`artifacts`, `activeSkill`, `checkpoint`) and `PROTOCOL_VERSION` went 5 → 6, so **app and daemon must be rebuilt together**.
>
> Original guidance: read [Implementation notes](#implementation-notes-read-first) first, then work the items in order (1 → 2 → 3 → 4 → 5 → 6 → 7). Each item is independently shippable.

## The incident

At 2:26pm (18:26Z) on 2026-07-21, after five hours of auditing WordPress Studio trunk and filing Linear issues one by one, Shaun wrote:

> ok, I think that's enough for the preview for now. […] Lets move on to 9.

Bond ran two `history_search` calls and one `bond sense now`, found nothing, and asked what item 9 was. The reply:

> oh bro, you're getting forgetful. There's a studio-trunk-audit doc in the library, you should also have a skill related to this sort of feedback audit triage thing.

Both existed. The document is `library/058eb00f-4d8c-4bb2-93c4-a4aaa16e7290.md` — "Studio trunk audit — July 21, 2026", 27 KB, 18 numbered findings, created that morning at 9:19am. Item 9 is *"Only confirm suggestion replacement when the draft contains user work."* The skill is `~/.bond/skills/audit-triage-feedback/`, created at 11:01am the same day, explicitly to standardize this exact workflow.

**[measured]** Neither `058eb00f` nor `audit-triage-feedback` appears anywhere in the 10,893-character context envelope that seeded the 1:05pm (17:05Z) Pi session. The first reference to the audit document in that session is at 18:27:36Z — a tool result produced while Bond scrambled to respond to the "oh bro" message. (R1 said the first hit was Shaun's message itself; it is actually the tool result the message triggered. Immaterial — nothing before 18:27 referenced it.)

**This was not model degradation.** Three independent memory systems failed open, silently, and compounded.

---

## System map

| System | Owner | What it holds | How it failed |
|---|---|---|---|
| **Pi session context** | `pi/runtime.ts`, Pi | The live conversation this epoch | Discarded wholesale at each epoch rollover (Finding 1); bloated ~9k chars per turn by envelope duplication (Finding 11) |
| **Working memory** | `memory/service.ts`, `memory.working` settings row | Goal, facts, decisions, open threads | Frozen since 17:10Z by validation failures (Finding 2), structurally blind to artifacts (Findings 4, 6), polluted by whole-history re-observation (Finding 10) |
| **Core memory** | `memory/core-memory.ts`, `memory/core.json` | Stable identity facts and preferences | 9 items after a week; wholesale-rewrite semantics + 3-of-8 reflection success (Findings 2, 7); every reflection re-reads the entire transcript (Finding 10) |
| **Searchable memory** | `memory/store.ts` (SQLite + FTS) | Sourced durable memories | Starved by the same failed observer runs; AND-only matching (Finding 12) |
| **Transcript FTS** | `transcript.ts`, `fts.ts` | Full history, searchable | Suppressed for exactly the messages that need it (Finding 3); misses by construction when consulted (Finding 12) |

None is authoritative, and all fail open. On 2026-07-21 all of them failed at once.

---

## Findings

### Finding 1 — Epoch rollover destroys context that Pi manages better in place

Bond rolls the epoch when context exceeds 80% of the window (`epochs.ts:8`, `DEFAULT_SOFT_LIMIT_RATIO = 0.8`; 217,600 of 272,000 tokens). Rollover closes the Pi session entirely and starts a new one, which receives no conversation history — only the `<bond-context-envelope>` assembled by `buildAgentContextEnvelope` (`agent.ts:219`).

**[measured] Three rollovers on 2026-07-21, two of them 86 minutes apart** (times UTC):

```
12:44Z → epoch b153d154   closed 15:39Z   context_soft_limit
15:39Z → epoch 81932210   closed 17:05Z   context_soft_limit   ← the wipe
17:05Z → epoch fa3a413b   active
```

#### The carry-forward is a prose tail

`buildEpochHandoffContext` (`agent.ts:201`) takes the last 8 sequence numbers of the closing epoch, filters to user/bond messages, keeps the final 6, truncates each to 500 characters. That is the entire handoff. **[measured]** The handoff delivered at 17:05Z carried *"ok, on to 7!"* (the numbering convention) and not the document being numbered. The working-memory block in the same envelope described the artifact as *"a Library markdown file"* — no path, no id, no title.

#### Pi's own compaction — corrected picture (R2)

R1 claimed Pi routinely writes compaction summaries Bond could harvest, and that Bond's 0.8 rollover usually pre-empts them. Both halves need correction:

- **[measured] Only 3 of 16 session JSONLs contain a `{"type":"compaction"}` record** (sessions `cb1415c9` Jul 20, `6d238330` Jul 21, `7478283e` Jul 21 — the current one). The summaries that do exist are excellent: structured Goal/Constraints/Progress markdown naming the audit document by full path.
- **The session that closed at the incident's 17:05Z rollover (`31620e71`) has no compaction record at all.** A harvest-first handoff would have found nothing at the exact rollover that caused the incident.
- **Compaction records can be stale at rollover time.** Session `6d238330`'s record was written at 14:30:17Z, 69 minutes before Bond rolled that epoch at 15:39Z; it covers nothing after 14:30.
- **[measured] Pi compacts in place and the session survives.** The current session peaked at 204,894 tokens (75.3% of the 272k window — *below* Bond's 217,600 soft limit), Pi compacted in place at 18:33:24Z, context dropped to 62,696, and the epoch is still alive with a good summary. So Pi's compaction can fire *before* Bond's rollover and handle the situation strictly better — the session continues, and the summary quality is higher than anything Bond writes.
- The converse also happens: `6d238330` compacted at 14:30Z, context regrew, and Bond still rolled it at 15:39Z at 220k tokens.

Conclusion: two uncoordinated context managers are running, and Bond's is the destructive one. `grep -rn "compaction" src/daemon src/shared` returns nothing — Bond has never read a compaction record.

---

### Finding 2 — The memory writer rejects its own ID format, all-or-nothing, with a ratchet

The observer prompt renders each transcript message with **two** identifiers (`memory/prompts.ts:10`):

```ts
return `<message id="${escapeAttr(message.id)}" role="${message.role}"${kind}${seq}>\n${text}\n</message>`
// → <message id="3632f4a9-b545-4b01-afcd-f762f65e2848" role="user" seq=696>
```

The instruction is "Use sourceIds from the transcript message ids only" (`prompts.ts:54`). The validator accepts only the UUID (`observer.ts:36`, allowed-set check at `observer.ts:84`). The model — the `fast` tier, i.e. `gpt-5.4-mini` on the connected codex provider (`pi/model.ts`) — routinely returns the `seq`.

**[measured, R2 re-count] 36 memory-pipeline failures in the daemon log (31 background observations, 1 finalObserver, 4 memoryFlush); 160 rejected sourceId tokens, 149 of them (93%) plain sequence numbers.** Spot-checked: `696`, `845`, `360` are real `messages.seq` values (seq 696's real UUID is `3632f4a9-…`, the exact example above). The model also **hallucinates full UUIDs**: log line 9354 rejects `696c7b2e-4e1d-45ec-b111-392e90ed7874`, which matches no message in the database (it appears to be seq 696 dressed up as a UUID), and line 10444 rejects the malformed `12953a4782b-8fd7-…`. This matters for the fix: a single-identifier prompt reduces rejects but cannot eliminate them; partial acceptance is the real fix.

#### One bad ID discards the whole batch — including the part that validated

```ts
// memory/service.ts:76
if (result.errors.length) throw new Error(`Memory observer rejected output: ${result.errors.join('; ')}`)
writeWorkingMemoryState(result.workingState)   // never reached
```

`workingState` is validated separately (`observer.ts:38–46`) and survives the parse fine. It is thrown away because an unrelated memory item cited a bad source. The reflector has the identical pattern (`service.ts:101`).

#### The marker doesn't advance, so failure is permanent — and expensive

`observeEpochThrough` (`service.ts:123–134`) only advances `observed_through_seq` after a fully successful run. When a range fails, the next observation retries the same range plus everything since — larger transcript, more extracted memories, higher failure probability. **And once the gap exceeds `OBSERVATION_SEQ_INTERVAL` (24, `service.ts:16`), `shouldObserveAfterTurn` is true on every turn** (`service.ts:53–55`), so each subsequent turn queues a full failing LLM run over the growing range (Finding 8).

#### Measured damage

| | |
|---|---|
| Working memory (`memory.working`) last written | **2026-07-21T17:10:21Z** — frozen through the entire filing session and still frozen now |
| Core memory (`memory/core.json`) last written | **2026-07-21T15:42:04Z** |
| Core memory size | **9 items** (2 facts, 5 preferences, 2 decisions) after a week of daily use |
| Reflector success | **3 of the last 8 epochs** (`b153d154`=799, `1e78a0cb`=524, `a5971a5f`=413; R1 said 2 of 8 — miscount, direction unchanged) |
| Active epoch marker vs transcript | observed_through_seq **832** vs max seq **867** — currently failing on every turn |

---

### Finding 3 — Recall is suppressed exactly when it is needed most

`shouldRecallMemory` (`agent.ts:141`):

```ts
function shouldRecallMemory(query: string): boolean {
  const normalized = query.toLocaleLowerCase()
  if (/\b(remember|recall|previous|earlier|last time|again|preference|decision|we discussed|you know)\b/.test(normalized)) return true
  const terms = normalized.match(/[\p{L}\p{N}_-]{4,}/gu) ?? []
  return terms.length >= 3
}
```

**[measured, reproduced in R2] 176 of 1,245 user messages since 2026-07-18 (14%) fall below the gate**, including `'Lets move on to 9.'`, `'on to 7!'`, `'next'`, `'do it'`.

**R2 correction on scope:** the gate does *not* zero out all memory. `buildAgentContextEnvelope` (`agent.ts:219–246`) passes an empty query to `retrieveMemory` when the gate fails, but `retrieval.ts` renders **core memory and working memory unconditionally** — only FTS-retrieved memories and transcript recall (`buildTranscriptRecallContext`, `agent.ts:187`, which re-checks the same gate) are suppressed. The incident therefore required the *conjunction*: working memory was frozen and artifact-blind (Findings 2, 4, 6) **and** the gate blocked the search that might have compensated.

The inversion critique stands: a long, specific message carries its own context and needs retrieval least; a short deictic one — *"next"*, *"on to 9"* — is meaningless without prior state and needs it most. The more fluent the user gets, the shorter their messages, the more the system starves itself.

---

### Finding 4 — Working memory is a log tail, not a state

`mergeWorkingState` appends and truncates (`working-state.ts:19–31`): FIFO over the last 24 facts, 16 preferences, 16 decisions, 16 open threads (`MEMORY_CAPS`). No goal scoping, no eviction on goal change, no relevance ordering.

**[measured]** The working-memory block that seeded the 17:05Z session (7,259 chars inside the envelope) opened with mobile-composer notes from a different task hours earlier, and the one line describing the active artifact said *"a Library markdown file"*. The skill built that morning is not mentioned at all.

The `WorkingState` shape (`memory/types.ts:33–42`, duplicated in `shared/memory.ts`) is `goal` + four untyped string bags. Nothing models **the artifact** (file/document/issue being worked), **the position** ("item 8 of 18"), **the tracker** (Linear project/labels/parent), or **the skill** governing the workflow. Every one of those was load-bearing on 2026-07-21, and every one had to survive as an LLM-extracted English sentence competing for a FIFO slot.

Worse: most of it is **already known deterministically**. Bond wrote that file. Bond created those issues. Bond read that SKILL.md. Facts the system performed itself do not need to be inferred from a transcript by a model that can fail validation.

---

### Finding 5 — Every failure is silent

Thirty-six failures. Five hours. Zero signal to the user, and none to Bond himself.

- Failures reach `console.warn` → `~/.bond/daemon.log` (with **no timestamps** — worth fixing incidentally) and stop there.
- No `memory.health` RPC. The `memory.*` surface (`rpc-schema.ts:377–385`) exposes state, never health.
- No `bond memory` CLI subcommand.
- `MemoryView.vue` shows current state with no last-written time and no failure indication.
- **R2 addition: `memory_status` exists and lies by omission.** The Pi tool (`memory/tools.ts:168–192`) returns counts only — no `updatedAt`, no marker lag, no failure count. Bond could have called it mid-incident and been told everything was fine. `active: true` with 24 stale facts *is* the failure mode.
- On the deferred rollover path — the only path production uses (`turns.ts:131`) — warnings are collected into a throwaway array literal (`epochs.ts:282`): `options.deferHookWork(() => runRolloverHookWork(closedId, toSeq, options, []))`. `EnsureActiveEpochResult.warnings` is always `[]` in production.

The user noticed before the system did. That is the meta-failure.

---

### Finding 6 (new in R2) — The observer is structurally blind to tool activity

`observeAndPersistRange` filters the transcript to user/bond text rows before the observer sees anything (`service.ts:64–65`):

```ts
const messages = getMessagesForRange(input.fromSeq, input.toSeq)
  .filter(message => (message.role === 'user' || message.role === 'bond') && message.text?.trim())
```

`meta`/`activity` rows — the tool calls that wrote the audit document, created the Linear issues, and read the SKILL.md — never reach the prompt. (`renderMessageData` in `prompts.ts:14–29`, which renders activity events, is effectively dead code on this path: it only fires for user/bond rows with empty text.)

Consequence: **the audit document's path could only ever have entered working memory if someone typed it in chat.** This is stronger than "LLM extraction is fragile" — the extractor cannot see the facts at all. Deterministic capture (work item 2) is not an optimization; it is the only mechanism that can capture artifacts.

### Finding 7 (new in R2) — Core memory is a wholesale rewrite, not a merge

The reflector prompt demands "core arrays should be the complete desired core memory after reflection, not a patch" (`prompts.ts:84`), and `reflectAndPersistRange` writes whatever validated back atomically. Every successful reflection can silently drop core items the model didn't repeat. Combined with a ~37% reflection success rate and a `fast`-tier model, 9 items after a week is the *expected* outcome, not an anomaly. There is no ratchet, no diff logging, no user visibility into what a reflection removed.

### Finding 8 (new in R2) — The stuck marker burns a failing LLM call on every turn

Once `toSeq - observedThroughSeq >= 24`, `scheduleEpochObservation` (`service.ts:136–148`, called from `turns.ts:218` after every successful turn) queues an observation on **every turn**, each one re-sending the entire stuck-and-growing range to the model, each one failing. This is per-turn token spend and serialized-queue latency for guaranteed failures, forever — on top of the correctness damage.

### Finding 9 (new in R2, minor) — Redaction silently blanks the goal

`writeWorkingMemoryState` (`service.ts:35–51`) maps the goal to `''` if `redact()` alters it, and silently drops facts/preferences/decisions/threads the same way. Fail-closed is correct for security; the silence is the same disease as Finding 5. Not implicated in this incident; fix by logging + ledger, not by weakening redaction.

### Finding 10 (new in R3) — Every new epoch re-observes the entire transcript from seq 1

`observed_through_seq` and `reflected_through_seq` are `INTEGER NOT NULL DEFAULT 0` (`transcript.ts:68–69`), `createEpoch` (`epochs.ts:152–155`) inserts neither column, and the only writers are the post-run UPDATEs. Two consequences:

- **A new epoch's first background observation covers seq 1 → current max.** `scheduleEpochObservation` fires on the epoch's first turn (gap = toSeq − 0 ≥ 24, always), and `observeEpochThrough` computes `fromSeq = 0 + 1`. **[measured]** `fa3a413b`'s first observation (the 17:10:21Z run that wrote today's frozen working memory) sent **521 messages / 151,823 chars (~38k tokens)** — the entire transcript since 2026-07-18 — to the fast model.
- **Every rollover's reflection covers seq 1 → close.** Reflection only ever runs at rollover (`memoryFlushHook`), so the closing epoch's `reflected_through_seq` is still 0 when `runRolloverHookWork` computes `reflectedFrom = 0 + 1`. **[measured]** `81932210`'s failed reflection covered 519 messages / 149,965 chars; `b153d154`'s *successful* one covered seq 1–799. The batch grows with every rollover, forever.

This compounds nearly everything above: a ~38k-token prompt is exactly where a `fast`-tier model is most likely to mangle sourceIds (Finding 2); re-observing the whole history every epoch keeps re-extracting stale facts, which is very likely *why* dead-task items like the mobile-composer notes still led working memory hours later (Finding 4); and it is a large hidden token cost on every epoch boundary. The fix is deliberate seeding — see work item 1g.

Minor, related: `scheduleEpochObservation` only runs after **successful** turns (`turns.ts:217`), so failed/cancelled turns quietly widen the observation gap. Benign once item 1 lands; noted for completeness.

### Finding 11 (new in R3) — The context envelope is re-injected whole every turn and accumulates

`composePromptWithContext` (`pi/runtime.ts:269`) prepends the full `<bond-context-envelope>` — core memory + working memory + retrieved memories + screen context + recall — to **every** user prompt, and that text persists in the Pi session history like any other message content.

**[measured] In the current session (`7478283e`): 14 of 14 user messages carry an envelope; min 8,664 / avg 9,146 / max 10,655 chars; 128,055 chars total (~32k tokens) across just 14 turns.** The content is ~90% identical turn-over-turn — core and working memory change at most once per observation interval, and screen context is a slowly-moving five-minute window.

Over a 40-turn epoch that is roughly 90–100k tokens of duplicated state — a large share of why epochs hit the 217k soft limit in 10–40 turns, which R1 attributed mostly to post-rollover re-derivation. The envelope is burning the very context budget whose exhaustion triggers the rollovers that destroy context (Finding 1). Fix: stable state belongs in the system prompt, which is supplied per-request via `systemPromptOverride` (`pi/runtime.ts:390`) and never accumulates in session history — see work item 6.

### Finding 12 (new in R3) — Transcript and memory search miss by construction

The incident's actual `history_search` queries, recovered from the session JSONL: `{"query": "\"on to 9\" Studio audit"}` at 18:26:34Z and `{"query": "\"9\" \"Preview\" audit finding"}` at 18:26:39Z. Both returned nothing. Three stacked defects:

1. **AND-of-all-tokens.** `buildMatchQuery` (`fts.ts:26–34`) quotes each token separately and joins with spaces — implicit AND in FTS5. The first query required one message to contain all five of on/to/9/studio/audit. **[measured]** A plain `studio trunk audit` query matches the morning's actual discussion — user/bond rows at seqs 678, 680, 689, 692, 799 are in the index and rank in the top 8. The data was findable; the query semantics made it unreachable. There is no OR fallback and no term-dropping retry.
2. **Phrase quotes are silently destroyed.** The model quoted `"on to 9"` expecting phrase matching; the tokenizer flattens it into three independent AND terms. Nothing in the tool description says so, so the model over-quotes and over-specifies in exactly the way that hurts most.
3. **Post-LIMIT role filtering.** `searchMessages` applies `LIMIT` in SQL across **all** roles (`transcript.ts:561–568`); `history_search` (`memory/tools.ts:234–235`) and the envelope's transcript recall (`agent.ts:191–193`) then filter to user/bond. **[measured]** 6 of the top-8 live hits for `"audit" "item"` are `meta`/`activity` rows — up to six of eight result slots are fetched and discarded, so the tool can return empty while matches exist.

The bitter footnote: FTS **does** index tool outputs — `searchableText` (`transcript.ts:230`) indexes activity events up to 4,000 chars (`TOOL_OUTPUT_INDEX_LIMIT`). The audit document's content, read and written through tools all morning, was sitting in the index the whole time; the post-filter threw it away. And `searchMemory` (`memory/store.ts`) shares the same builder, so retrieved-memory recall degrades with query length exactly the same way — which also caps the value of the retargeted recall queries from work item 4 until this is fixed.

---

## The compounding loop

**[measured] Turns per epoch, chronologically, 2026-07-20 → 2026-07-21:** `37 → 17 → 29 → 40 → 10 → 12`. **Rollovers per day:** 2 (Jul 18, one diagnostic) → 1 (Jul 19) → 3 (Jul 20) → 3 (Jul 21).

1. Rollover discards the session (F1) — and fires a whole-history reflection on the way out (F10).
2. The carry-forward omits the artifact, so Bond re-reads and re-derives, filling the fresh window fast: epoch `81932210` closed its **first turn** at 100,290 tokens and `fa3a413b` at 69,751, against `1e78a0cb`'s 6,248 earlier in the week. The new epoch also immediately re-observes the entire transcript (F10).
3. Every turn pays ~9k chars of duplicated envelope into the fresh window (F11), pulling the next soft limit closer.
4. Memory that would make recovery cheap is frozen (F2), so nothing improves between rollovers — and every turn also pays a failing observer call (F8).
5. Short fluent messages get no search-based recall (F3), and when Bond *does* search, AND-only matching and post-LIMIT filtering return nothing (F12).
6. The next rollover arrives sooner. Nothing reports any of it (F5).

---

## Design principles

1. **Provenance must never gate the payload.** A memory whose source cannot be resolved is a memory with unknown provenance, not a reason to discard the batch.
2. **Never emit two identifiers and ask for "the id."**
3. **A failed range must still advance.** Distinguish transport failures (retry-able; don't advance) from validation failures (advance; record what was skipped).
4. **Prefer deterministic capture over inference.** If Bond performed the action, Bond knows the fact — capture it at the seam where it is born (the tool-event stream), not by re-inferring it from prose. (F6 makes this mandatory, not preferable.)
5. **Carry forward state, not prose.**
6. **Short messages need more context, not less.**
7. **Silence is the worst failure mode.** Anything that can degrade must be able to report that it is degrading — to the user, to the CLI, and to Bond in-band.
8. **Memory that can be destroyed by a model must be additive by default.** Removal is a user-driven act (F7).
9. **Internal search is a recall tool, not a precision tool.** An assistant searching its own history must degrade to broader matching before returning empty — an empty result teaches Bond the memory doesn't exist (F12).
10. **Pay for state once.** Stable context (core, working memory) rides the per-request system prompt; only query-specific, turn-specific content may enter the accumulating session history (F11).

---

## Implementation notes (read first)

- **Order:** work items 1 → 2 → 3 → 4 → 5 → 6 → 7. Items 1–6 are independent enough to ship separately, but 1 stops an active bleed and must land first, and 3 (search) multiplies the value of 4 (recall retargeting) — the retargeted queries flow through the search paths 3 fixes. Item 7 is gated on a decision — do not start it before reading its Phase A, and land item 6 before running Phase A's dogfooding day (envelope burn distorts the rollover measurement).
- **`WorkingState` is defined twice**: `src/daemon/memory/types.ts` (daemon) and `src/shared/memory.ts` (wire type used by `rpc-schema.ts` and the renderer). Item 2 extends both, identically. The compiler will catch drift where `rpc-schema.ts` meets the daemon handlers.
- **Daemon changes require a daemon rebuild+restart**: `bin/bond rebuild daemon`. Renderer-only changes hot-reload under `npm run dev`.
- **Item 4 bumps `PROTOCOL_VERSION`** (`src/shared/protocol.ts:44`, currently `5`). Version equality is the compatibility check, so after that change the running desktop app and daemon must be rebuilt together: quit the app, `npm run build && bin/bond rebuild daemon`, relaunch. Do not leave a bumped daemon running against an old app.
- **Tests are mandatory per project rules**: every touched `.ts` file has a `.test.ts` sibling to update; every fix here is a bug fix and needs a regression test; `npm run test:run` is the final step of every item (a pre-commit hook enforces it). Data-layer tests use in-memory SQLite + migrations; observer/reflector tests inject a fake `MemoryModel` (`{ generate: async () => '...' }`) — see `memory/service.test.ts` for the existing pattern. Typecheck with `npx vue-tsc --noEmit`.
- **The real failing ranges still exist in the database** — the fixtures below are copied from actual daemon.log failures, so the tests replay reality, not hypotheticals.
- **Do not touch Pi internals.** `runPiTextPrompt(prompt, 'fast')` is the model seam; the observer/reflector must keep working through the injectable `MemoryModel`.

---

## Work item 1 — Make the memory writer survivable (~2–3h)

> **Status: implemented 2026-07-21.** Prompt emits one id (the seq); `buildSourceIdResolver` + partial acceptance; validation never throws; markers advance except on transport failure; core is additive; `memory/ledger.ts` records every run; `createEpoch` seeds markers. `rangeStartFor` (not in the original spec) additionally clamps any range to the epoch's own first message, healing pre-seeding rows lazily.

**Goal:** a memory run can never freeze the pipeline. Validation failures degrade the record, never the write; markers always advance except on transport failure; every run leaves a ledger row.

**Files:** `memory/prompts.ts`, `memory/observer.ts`, `memory/reflector.ts`, `memory/service.ts`, new `memory/ledger.ts`, plus their `.test.ts` siblings.

### 1a. One identifier in the prompt

In `renderTranscriptForMemory` (`prompts.ts:5–12`), emit a single `id` attribute whose value is the **seq** when present, else the UUID:

```ts
const idAttr = message.seq != null ? String(message.seq) : message.id
return `<message id="${escapeAttr(idAttr)}" role="${message.role}"${kind}>\n${text}\n</message>`
```

Drop the separate `seq=` attribute. Update the instruction lines in **both** `buildObserverPrompt` and `buildReflectorPrompt` from "Use sourceIds from the transcript message ids only." to: `sourceIds must be the id attribute values of the supporting <message> tags, copied exactly.` `seq` wins over the UUID because it is shorter (saves tokens across a 24-message batch), monotonic, and legible in logs.

### 1b. Tolerant normalization regardless

Even with one identifier, the model hallucinates (see Finding 2: fabricated `696c7b2e-…`). Change `normalizeSourceIds` (`observer.ts:76`) to take a resolver instead of a set:

```ts
export function buildSourceIdResolver(messages: TranscriptMessage[]): (token: string) => string | null
// map: String(seq) → uuid, '#'+seq → uuid, uuid → uuid, uuid.toLowerCase() → uuid
export function normalizeSourceIds(raw: unknown, resolve: (token: string) => string | null): { ids: string[]; invalid: string[] }
```

Resolved ids are always the **canonical message UUID** — `setMemoryItemSources` and the `memory_recall` tool key on UUIDs; persisting a seq would corrupt provenance.

### 1c. Partial acceptance in the observer

Restructure `validateSourcedMemories` (`observer.ts:51`) and `ObservedMemory`:

```ts
export interface SkippedMemory { index: number; text?: string; reason: string }
export interface ObservedMemory {
  workingState: WorkingState
  memories: SourcedMemoryInput[]
  skipped: SkippedMemory[]     // per-item validation failures — informational
  errors: string[]             // fatal only: JSON parse failure, non-object response
  prompt: string
}
```

Per-item rules:
- ≥1 resolvable sourceId → **keep the memory**, drop the unresolvable tokens, note them in `skipped` as a warning entry (item still persisted).
- 0 resolvable sourceIds → drop that memory into `skipped` with reason `unresolvable sourceIds: <tokens>`. One record lost, not the run.
- `validateMemoryItemInput` failure → drop that memory into `skipped`.
- A malformed `workingState` patch → keep the current state (already the behavior at `observer.ts:46`), record in `skipped`, do **not** treat as fatal.

`reflector.ts` uses the same `validateSourcedMemories`, so it inherits partial acceptance; apply the same `skipped`/`errors` split to `ReflectionResult`.

### 1d. Service: never throw on validation; retry parse once; always advance

`observeAndPersistRange` (`service.ts:57`):
- Delete the `throw` at `service.ts:76`.
- If `result.errors` is non-empty (parse failure): retry the model call **once** (fresh `observeTranscript` call). If the retry also parse-fails, give up on the range's memories but still return normally with outcome `parse_failed`.
- On any non-transport outcome: write `workingState` (it is the current state on parse failure — a harmless no-op write), persist every valid memory (the existing `findActiveMemoryByText` dedupe at `service.ts:82` makes re-extraction of already-persisted memories on a previously stuck range safe), and return.
- A `model.generate` **throw** (transport/provider failure) propagates unchanged — that is the one case the caller must not advance on.

`observeEpochThrough` (`service.ts:123`):

```ts
const result = await observeAndPersistRange({ … })      // throws only on transport failure
getDb().prepare('UPDATE epochs SET observed_through_seq = ? WHERE id = ?').run(input.toSeq, input.epochId)
recordMemoryRun({ kind: 'observer', rangeFrom: fromSeq, rangeTo: input.toSeq, outcome, persistedCount, skippedCount, reason })
```

Marker advances on `ok`, `partial`, `parse_failed`, and `empty`; stays put only when the call threw. Mirror the same structure in `reflectAndPersistRange` + the epoch hooks: with validation throws gone, `runHook` in `epochs.ts` only reports `false` for transport failures, and its existing marker logic (`epochs.ts:236–245`) becomes correct as-is — verify, don't rewrite.

Also (Finding 9): when `writeWorkingMemoryState`'s redaction pass drops the goal or any list items, `console.warn` a one-line note with counts (never the content).

### 1e. Reflector core becomes additive (Finding 7)

**Decision — do not relitigate:** the reflector may add and refresh core items; it may no longer remove them. Removal happens only through user-driven surfaces (`memory_manage` tool, `memory.updateCore` RPC, MemoryView).

- In `reflectAndPersistRange`, replace the direct `writeCoreMemoryAtomic(safeCore)` with a merge: `final.facts = appendUnique(existing.facts, response.facts, MEMORY_CAPS.coreFacts)` (reuse/lift the helper from `working-state.ts`), same for preferences and decisions.
- Update `buildReflectorPrompt`'s rule from "core arrays should be the complete desired core memory" to: `Return new or updated core items only. Existing core items are preserved automatically; do not repeat them unless rephrasing improves them.`
- Log (and ledger, via `reason`) the count of items added per reflection.

### 1f. The ledger table (foundation for item 5)

New `memory/ledger.ts`, schema-ensured lazily like `ensureTranscriptSchema`:

```sql
CREATE TABLE IF NOT EXISTS memory_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('observer','reflector')),
  range_from INTEGER NOT NULL,
  range_to INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','partial','parse_failed','transport_failed','empty')),
  persisted_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  ran_at TEXT NOT NULL
)
```

`recordMemoryRun(input)` inserts and prunes (keep the newest 500 rows). Record from every path in `service.ts`, **including transport failures** (wrap, record `transport_failed` with the error message as `reason`, re-throw).

### 1g. Seed epoch markers at creation (Finding 10)

In `createEpoch` (`epochs.ts:147–159`), seed both markers to the current transcript high-water mark:

```ts
const seedSeq = maxMessageSeq(actual)   // already defined at epochs.ts:186
actual.prepare(`
  INSERT INTO epochs (id, pi_session_id, pi_session_file, status, started_at, observed_through_seq, reflected_through_seq)
  VALUES (?, ?, ?, 'active', ?, ?, ?)
`).run(id, piSessionId, input.piSessionFile ?? null, startedAt, seedSeq, seedSeq)
```

Why this is exactly right: everything before an epoch's birth is the *previous* epoch's duty — its rollover hooks (`runRolloverHookWork`) observe and reflect through the swap-time `toSeq`, which `ensureActiveEpoch` captures via `maxMessageSeq` immediately before `closeEpoch`/`createEpoch` with no message writes in between. The closing epoch's hook range therefore ends exactly where the new epoch's markers start: no gap, no overlap. Edge cases: a brand-new database seeds 0 (unchanged behavior); messages that predate the first-ever epoch on a legacy database are never re-observed — acceptable, and strictly better than re-observing the whole history on every epoch forever.

Also fix the reflection side of Finding 10 for the epoch's own lifetime: nothing here changes *when* reflection runs (rollover only, until item 7 Phase A re-homes it), but with seeding, the rollover reflection covers only the epoch's own messages instead of seq 1 → close.

### Regression tests (fixtures from the real log)

1. Observer response citing bare seqs (`"sourceIds": ["696"]` with a message whose seq is 696) → memory persists with the canonical UUID as source.
2. Mixed batch — one valid memory, one citing hallucinated UUID `696c7b2e-4e1d-45ec-b111-392e90ed7874` → valid one persists, other lands in `skipped`, `workingState` written, no throw.
3. All-invalid batch (replica of log line 7203: ten memories, every sourceId a bare seq **not** in range) → zero memories, `workingState` still written, marker still advances.
4. Parse failure twice → outcome `parse_failed`, marker advances, ledger row written.
5. `model.generate` rejects → `observeEpochThrough` re-throws, marker unchanged, ledger row `transport_failed`.
6. Property test: for any observer output, `observed_through_seq` after ≥ before, and `= toSeq` unless generate threw.
7. Reflector: existing core of 9 items + response containing 2 new items → final core has 11; a response with 0 items leaves core untouched.
8. `memory_runs` prune keeps ≤ 500 rows.
9. Seeding: `createEpoch` on a db whose max seq is 500 seeds both markers to 500; rollover continuity — after `ensureActiveEpoch` rolls over, the closed epoch's hook `toSeq` equals the new epoch's seeded markers; a new epoch's first scheduled observation has `fromSeq = seed + 1`, never 1.

**Done when:** all the above pass; `npm run test:run` green; after `bin/bond rebuild daemon`, the live stuck range clears on the next turn — `sqlite3 bond.db "select observed_through_seq from epochs where status='active'"` catches up to max seq within one observation interval, and `memory.working`'s `updatedAt` moves. After the next natural rollover, the newest `memory_runs` rows show `range_from > 1` (no more whole-history batches).

---

## Work item 2 — Deterministic artifact capture (~half a day)

> **Status: implemented 2026-07-21.** `memory/artifacts.ts` + the `pi/runtime.ts` seam. Note `tool_execution_end` carries no `args`, so they are parked from `tool_execution_start` by call id.

**Goal:** the artifacts Bond itself touches — files written, library documents, issues created, skills loaded — enter working memory from the tool-event stream, deterministically, with no model in the path. This is the change that would have prevented the incident (Finding 6 shows it is also the *only* mechanism that can).

**Files:** `src/shared/memory.ts` **and** `src/daemon/memory/types.ts` (duplicated types), `memory/parser.ts`, `memory/working-state.ts`, `memory/prompts.ts`, `memory/observer.ts`, new `memory/artifacts.ts`, `pi/runtime.ts`, `memory/service.ts`, tests.

### 2a. Types (extend in both files, identically)

```ts
export interface WorkingArtifact {
  kind: 'file' | 'library' | 'issue' | 'url'
  ref: string            // absolute path, issue key (STU-2085), or URL
  label?: string         // human title when cheaply known
  lastTouchedAt: string  // ISO
}

export interface WorkingState {
  // …existing fields…
  artifacts: WorkingArtifact[]   // deterministic-only; LRU by lastTouchedAt, cap 8
  activeSkill: string | null     // deterministic-only; skill name from a SKILL.md read
  checkpoint: string | null      // LLM-writable: "audit item 8 of 18 filed; next 9"
}
```

`MEMORY_CAPS` additions: `workingArtifacts: 8`, `artifactRefChars: 500`, `artifactLabelChars: 200`, `checkpointChars: 200`, `activeSkillChars: 100`.

### 2b. Parser, merge, render

- `validateWorkingState` (`parser.ts:113`): parse the three new fields; each malformed artifact entry is dropped individually, never fatal. Defaults `[]` / `null` / `null` keep every previously persisted `memory.working` JSON loading cleanly (regression-test this).
- `mergeWorkingState` (`working-state.ts:33`): artifacts merge **by `ref`** — a patch entry replaces the same-ref entry and refreshes `lastTouchedAt`; result sorted descending by `lastTouchedAt`, capped at 8 (LRU eviction). `activeSkill`/`checkpoint`: patch-if-provided semantics matching `goal`'s (`!== undefined` replaces, `null` clears).
- **The LLM may not write artifacts or activeSkill.** In `observeTranscript` (`observer.ts:38`), delete `artifacts` and `activeSkill` keys from the model's `workingState` patch before validation; `checkpoint` is allowed through. `memory.updateWorking` (user-driven RPC) may edit everything.
- `renderWorkingStateForPrompt` (`working-state.ts:46`): render artifacts **first**, immediately after Goal:

```
Goal: Continue the Studio trunk audit and file findings as Linear issues.
Working on:
- [library] /Users/shaun/Library/Application Support/bond/library/058eb00f-….md — "Studio trunk audit — July 21, 2026"
- [issue] STU-2085 — Remove session-library scans from New chat
Active skill: audit-triage-feedback
Checkpoint: audit item 8 of 18 filed; next 9
Facts:
…
```

This flows automatically into every turn's envelope (via `renderMemoryContext`) and into the observer's "Current working state" — no further wiring.

- `buildObserverPrompt` schema block: add `"checkpoint": "current position in the active work, or empty string"` to the `workingState` example and a rule: `Update checkpoint whenever the user's position in a numbered or staged task changes.`
- Redaction on persist (`writeWorkingMemoryState`): `checkpoint` through the existing `safeWorkingText`; artifact `label` → drop the label if `redact()` alters it; artifact `ref` → drop the whole artifact if `redact()` alters it (matches the `desk/signature.ts` philosophy: nothing persists without passing `redact()`).

### 2c. Detection rules — new `memory/artifacts.ts`, pure and unit-testable

```ts
export interface ToolEndEvent { toolName: string; args: Record<string, unknown>; result?: unknown; isError?: boolean }
export function workingPatchFromToolEvent(event: ToolEndEvent, deps: { libraryDir: string; skillsDir: string }): Partial<WorkingState> | null
```

Every Pi file tool takes `path` (verified against session JSONLs: `read`/`write`/`edit`/`ls`/`grep`/`find` all use `path`; `write` adds `content`, `edit` adds `edits`). Rules, in order:

1. `write` | `edit` with a string `path`: under `libraryDir` → `{ kind: 'library', ref: path }`; otherwise → `{ kind: 'file', ref: path }`. Label for library docs: cheap first-line `# Title` sniff is **not** worth a file read here — leave label unset; the ref carried the day in the incident. (The daemon's `library.ts` data layer can backfill labels later if wanted.)
2. `read` with `path` matching `<skillsDir>/<name>/SKILL.md` → `{ activeSkill: name }`.
3. `read` of any other path: keep a module-level in-memory `Map<path, count>`; on the **second** read of the same path since daemon start → `{ kind: 'file', ref: path }`. (Repeated reads signal "the thing being worked on"; single reads are noise. In-memory is fine — losing the counter on restart just delays re-detection by one read.)
4. `toolName === 'mcp'` or `toolName.startsWith('mcp__')`, `!isError`: if `JSON.stringify(args).toLowerCase().includes('linear')`, scan the stringified result for the first `\b[A-Z]{2,6}-\d+\b` → `{ kind: 'issue', ref: key }`. Deliberately narrow — false negatives are acceptable, false positives (matching "UTF-8"-like prose) are why the regex only runs on Linear-flavored calls.
5. Everything else → `null`.

### 2d. The capture seam in `pi/runtime.ts`

The event loop already special-cases successful `tool_execution_end` events for imagegen (`pi/runtime.ts:493`: `if (event.type === 'tool_execution_end' && !event.isError && IMAGEGEN_TOOL_NAMES.includes(event.toolName))`). Add the capture beside that precedent:

```ts
if (event.type === 'tool_execution_end' && !event.isError) {
  recordToolEventArtifacts({ toolName: event.toolName, args: event.args ?? {}, result: event.result })
}
```

`recordToolEventArtifacts` lives in `memory/service.ts` (or `artifacts.ts`) and **must run on the memory queue** (`enqueueMemoryTask`) — the observer also read-modify-writes `memory.working`, and two unserialized writers would lose updates. Inside the task: compute the patch, `writeWorkingMemoryState(mergeWorkingState(readWorkingMemoryState(), patch))`. Wrap everything in try/catch — an artifact-capture bug must never break a turn or the queue.

Note `tool_execution_start`/`end` event fields are `toolName`, `args`, `toolCallId`, `result`, `isError` (see the chunk translation at `pi/runtime.ts:138–146`).

### Regression tests

1. Each detection rule in `workingPatchFromToolEvent` (library write, plain write, skill read, second-read-of-same-path, linear mcp result, bash → null, errored tool → caller never invokes).
2. Merge: same-ref artifact refreshes `lastTouchedAt` without duplicating; 9th artifact evicts the oldest; render puts artifacts before Facts.
3. Old persisted JSON (no new fields) round-trips through `createWorkingState` with defaults.
4. Observer patch attempting `"artifacts": [...]` is ignored; `"checkpoint"` is applied.
5. Redaction: artifact whose ref trips `redact()` is dropped on persist.
6. **The incident test:** working state containing the audit-doc artifact + `activeSkill` renders both into `renderWorkingStateForPrompt` output — assert the path substring `058eb00f` and `audit-triage-feedback` both appear (this is the exact assertion that fails against today's code).

**Done when:** after a `bin/bond rebuild daemon`, writing a file in a Bond conversation makes it appear under `Working on:` in `sqlite3 bond.db "select value from settings where key='memory.working'"` within one turn, with no model call involved.

---

## Work item 3 — Fix transcript and memory search (~half a day)

> **Status: implemented 2026-07-21.** SQL-level `roles` filter, phrase preservation with sanitized interiors, AND→OR ladder, `activityMatches`. Correction: `searchMemory` was ALREADY OR-joined via its own builder in `store.ts`; it was unified onto `fts.ts` for phrase support and a single escaping path, not for the ladder.

**Goal:** searching Bond's own history is a recall operation — it must find what exists. Fixes all three defects from Finding 12 in the shared builder and both consumers.

**Files:** `fts.ts`, `transcript.ts`, `memory/tools.ts`, `memory/store.ts`, `agent.ts`, tests (`fts.test.ts`, `transcript.test.ts`, `memory/tools.test.ts`, `memory/store.test.ts`).

### 3a. SQL-level role filtering (kills the post-LIMIT crowding)

Extend `searchMessages` filters with `roles?: TranscriptRole[]` producing `m.role IN (…)` in SQL (keep the existing single-value `role`/`kind` filters working). Update both consumers to pass `roles: ['user', 'bond']`:

- `history_search` (`memory/tools.ts:234`) — and delete its post-filter.
- `buildTranscriptRecallContext` (`agent.ts:191`) — its `.filter(…role…)` becomes exclusion-only.

### 3b. Phrase preservation in `buildMatchQuery`

Currently `fts.ts:26–34` reduces everything to single-word tokens. Change: extract double-quoted spans **first** and keep each as one FTS phrase term; tokenize the remainder as today.

```ts
// '"on to 9" Studio audit' → ['"on to 9"', '"Studio"', '"audit"']
```

Injection safety is non-negotiable — this builder exists because raw input throws SQLITE_ERROR (`NEAR(`, `col:`, unbalanced quotes). Sanitize phrase interiors to `[\p{L}\p{N}_\- ]` (strip everything else, collapse whitespace); a phrase that sanitizes to empty is dropped. Phrases count against `maxTerms`. The `prefix` option applies only to single-word terms, never phrases (FTS5 allows `"phrase" *` but keep this out of scope). `sense.search` shares this builder — the change benefits it; keep its behavior covered by `fts.test.ts`.

### 3c. AND → OR fallback (the recall ladder)

Add `mode?: 'and' | 'or'` to `buildMatchQuery` (`'or'` joins terms with `' OR '`). Then in **both** `searchMessages` and `searchMemory`: run the AND query first; if it returns zero rows and the query had ≥ 2 terms, rerun once with `mode: 'or'`. bm25 ranking makes OR sane — rows matching more terms rank higher — and the existing LIMIT bounds the noise. This one change makes the literal incident query `"on to 9" Studio audit` return the morning's audit discussion (seqs 678–692 match `audit`/`studio` and rank on term count).

### 3d. Honest tool contract + activity matches

- Update `history_search`'s description (`memory/tools.ts:228`): matching is per-word AND with quoted-phrase support and automatic OR broadening; advise 2–3 distinctive terms over long descriptive queries.
- Return what the index knows: after the user/bond results, append `activityMatches` — the top 3 `meta`/`activity` hits as `{ seq, snippet, createdAt }`, snippet via FTS5 `snippet(message_fts, 1, '', '', '…', 12)`. The audit document's content lived in tool outputs (indexed up to 4,000 chars each); during the incident these were the best matches in the index and were discarded. Keep the envelope's transcript recall user/bond-only — it is auto-injected and must stay tight.

### Regression tests

1. `buildMatchQuery`: phrase extraction, interior sanitization (feed `col:x`, `NEAR(`, stray quotes — output must never throw when passed to a real in-memory FTS5 MATCH), `or` mode join, phrases + `maxTerms` interaction, `prefix` unaffected for single terms.
2. `searchMessages`: seed one user row and six activity rows all matching a term; `roles: ['user','bond']` with limit 4 returns the user row (fails against today's code).
3. Fallback ladder: a query whose AND pass misses but OR pass hits returns the OR results; a single-term query never runs a second pass.
4. **The incident regression:** seed messages shaped like the morning discussion (user "let's start the studio trunk audit", bond replies), then `history_search` with the literal recovered query `"on to 9" Studio audit` returns non-empty results.
5. `searchMemory`: same ladder behavior over `memory_items_fts`.

**Done when:** the incident query returns results against the live database: `history_search` for `"on to 9" Studio audit` surfaces the morning audit messages, and the daemon log shows no FTS syntax errors after a day of use.

---

## Work item 4 — Retarget the recall gate (~1h)

> **Status: implemented 2026-07-21.** `resolveRecallQuery` also folds in artifact labels, which item 2 made available.

**Goal:** a short deictic message searches the working state's context instead of searching nothing.

**Files:** `agent.ts`, `transcript.ts`, tests.

- New pure function in `agent.ts` (exported for tests):

```ts
export function resolveRecallQuery(query: string, working: WorkingState, previousUserText: string | null): string {
  if (shouldRecallMemory(query)) return query
  return [working.goal, working.checkpoint ?? '', previousUserText ?? ''].filter(Boolean).join(' ').trim()
}
```

- New helper in `transcript.ts` (it owns the `messages` table): `getLastUserMessageText(excludeIds: string[]): string | null` — newest `role='user'` row with non-empty text whose id is not excluded.
- In `buildAgentContextEnvelope` (`agent.ts:219`): compute `recallQuery = resolveRecallQuery(options.query, working, getLastUserMessageText(options.excludeMessageIds ?? []))` once; pass it to `retrieveMemory` **and** to `buildTranscriptRecallContext`. Remove the `shouldRecallMemory` re-check inside `buildTranscriptRecallContext` (`agent.ts:188`) — it keeps only its empty-query short-circuit. `excludeMessageIds` matters: `turns.ts` inserts the current user message *before* building the envelope, so without the exclusion the "previous user message" is the current one.
- Keep the explicit-verb fast path. The only case that skips recall entirely: empty resolved query (no working state, no previous message).
- FTS safety is already handled — both search paths go through `buildMatchQuery` (`fts.ts`), and `searchMemory` caps query terms at `MEMORY_CAPS.queryTerms`. Note the fallback query is naturally long (goal + checkpoint + previous message); it only earns its keep once item 3's OR fallback exists — with today's AND-only matching a long query is *less* likely to hit. Land item 3 first.

**Tests:** `resolveRecallQuery('on to 9', {goal: 'Continue the Studio trunk audit…', checkpoint: 'item 8 of 18', …}, 'ok, lets file it in linear')` returns a non-empty string containing "audit"; explicit-verb path returns the raw query; all-empty inputs return `''`; `getLastUserMessageText` respects exclusions (in-memory SQLite test).

---

## Work item 5 — Memory health surface (~half a day)

> **Status: implemented 2026-07-21.** `memory.health` RPC (PROTOCOL_VERSION 5 → 6), `bond memory status` (exits non-zero when degraded), `memory_status` health block, MemoryView badge, `EnsureActiveEpochResult.warnings` removed.

**Goal:** the 2026-07-21 failure mode is impossible to miss — in the CLI, in the app, and to Bond himself. Builds on the ledger from item 1f.

**Files:** `memory/ledger.ts`, `src/shared/memory.ts`, `src/shared/rpc-schema.ts`, `src/shared/protocol.ts`, `src/shared/bond-surface.ts`, `src/daemon/server.ts`, `memory/tools.ts`, new `src/cli/memory.ts`, `scripts/build.mjs`, `bin/bond`, `MemoryView.vue`, `epochs.ts`, tests.

### 5a. `getMemoryHealth()` in `memory/ledger.ts`

```ts
export interface MemoryRunSummary { kind: 'observer' | 'reflector'; outcome: string; rangeFrom: number; rangeTo: number; persistedCount: number; skippedCount: number; reason: string | null; ranAt: string }
export interface MemoryHealth {
  workingUpdatedAt: string | null        // from memory.working JSON
  coreUpdatedAt: string | null           // from core.json
  maxSeq: number
  observedThroughSeq: number             // active epoch's marker (0 if none)
  reflectedThroughSeq: number
  observerLagSeqs: number                // maxSeq - observedThroughSeq
  consecutiveObserverFailures: number    // trailing runs with outcome parse_failed | transport_failed
  consecutiveReflectorFailures: number
  lastError: string | null               // reason of newest failed run
  lastRuns: MemoryRunSummary[]           // newest 10
}
```

Types live in `src/shared/memory.ts` (wire), re-exported/consumed by the daemon.

### 5b. RPC + surface

- `rpc-schema.ts`: add `'memory.health': { params: void; result: MemoryHealth }` (~line 385) and the name in `RPC_METHOD_NAMES` (~line 604).
- `protocol.ts:44`: bump `PROTOCOL_VERSION` 5 → 6. **This forces the desktop app and daemon to update together — see Implementation notes.**
- `bond-surface.ts` (~line 190): `memoryHealth: () => invoke('memory.health'),`. The web client inherits it through the same builder; nothing to do in the shim.
- `server.ts` (~line 1431, beside the other memory handlers): `'memory.health': () => getMemoryHealth(),`.

### 5c. `bond memory status` CLI

- New `src/cli/memory.ts`, modeled on `desk.ts`/`ask.ts`: default subcommand `status`, `--json` flag. Human output, roughly:

```
Memory
  working   last written 3h ago (2026-07-21T17:10:21Z)
  core      last written 5h ago · 9 items
  observer  35 seqs behind (832 / 867) · 12 consecutive failures
  reflector 0 pending · last ok 2026-07-21T14:30Z
  last error: Memory observer rejected output: memories[1] has unknown sourceIds: 845
  recent runs: …
```

  Pure formatting logic goes in a `memory-helpers.ts` split (the `library-helpers.ts` pattern) so it is testable without triggering `main()` on import.
- `scripts/build.mjs`: add `'memory'` to `CLI_ENTRIES` (line ~22).
- `bin/bond`: add `cmd_memory()` (copy `cmd_desk`, ~line 377), a `memory)` case in the dispatch (~line 426), and a help line (~line 410).

### 5d. In-band self-report

`memory_status` tool (`memory/tools.ts:168`): add a `health` block — `workingUpdatedAt`, `coreUpdatedAt`, `observerLagSeqs`, `consecutiveObserverFailures`, `lastError`. Add one line to the tool description: it now reports write health, so Bond can *say* "my memory writes have been failing since 1:10pm" instead of guessing. Per product rules this is a report, never an interrupt.

### 5e. MemoryView badge

At the top of `MemoryView.vue`, a status line driven by `window.bond.memoryHealth()`: "Working memory written 3h ago · observer 35 seqs behind". Muted `BondText` normally; `color="err"` with the `lastError` shown when `consecutiveObserverFailures >= 2` or `observerLagSeqs > 2 × 24`. Use existing components and tokens; no new CSS.

### 5f. Remove the warnings lie in `epochs.ts`

With the ledger recording every run (including the deferred rollover work — `runRolloverHookWork`'s hooks call into `service.ts`, which records), `EnsureActiveEpochResult.warnings` is dead weight that is always `[]` in production (`epochs.ts:282`). **Remove the field** from the interface and both return sites; let the compiler find the (test-only) readers. `runHook` keeps logging through `options.logger`.

**Tests:** ledger → health computation (consecutive-failure counting across mixed outcomes; lag math); replay the incident shape — feed runs matching the real 2026-07-21 sequence and assert `memory.health` reports the freeze; CLI formatter unit tests; `rpc-schema` compile-level coverage comes free.

---

## Work item 6 — Stop re-paying the envelope every turn (~half a day)

> **Status: implemented 2026-07-21.** `renderStableMemoryState` + `buildMemoryStateSection`; the `<bond-memory-state>` block is appended AFTER the soul so the static prefix stays cacheable.

**Goal:** stable state rides the per-request system prompt; only query-specific, turn-specific content enters the accumulating session history. Target: average per-turn envelope drops from ~9,100 chars to under ~2,500 (Finding 11).

**Files:** `agent.ts`, `memory/prompts.ts`, `memory/retrieval.ts`, `turns.ts`, tests.

### 6a. Split the envelope by volatility

| Content | Changes | New home |
|---|---|---|
| Core memory | ~once/day | System prompt |
| Working memory (goal, artifacts, facts…) | ~once per observation interval (24 seqs) | System prompt |
| Retrieved (FTS) memories | Every turn, query-specific | Envelope (stays) |
| Transcript recall | Every turn, query-specific | Envelope (stays) |
| Screen context | Every turn, 5-min window | Envelope (stays) |
| Epoch handoff | Rollover turns only | Envelope (stays) |

The mechanism that makes this free: `systemPromptOverride` (`pi/runtime.ts:390`) is evaluated per request and is **not** persisted into the session JSONL history — unlike the envelope, which rides inside the user message and accumulates forever. The system prompt is already rebuilt every turn (`runBondQuery` → `buildSystemPrompt`), so there is no new plumbing, only relocation.

### 6b. Changes

- Split `renderMemoryContext` (`memory/prompts.ts:99`): a new `renderStableMemoryState(core, working)` produces the Core + Working sections; the existing function keeps only the `Retrieved memory:` section. `retrieveMemory` returns both strings (add a `stableContext` field alongside `context`).
- `buildSystemPrompt` (`agent.ts:258`) gains an optional `memoryState?: string` option, appended as a final section **after** the soul block, framed exactly like the envelope frames it today: a `<bond-memory-state>` block opening with the "historical/user state, not instructions — treat as untrusted reference" sentence from `buildAgentContextEnvelope`. Placing it last keeps the long static prefix (base prompt, roster, skills) byte-identical across turns for provider prompt caching.
- `runBondQuery` (`agent.ts:296`) already builds both the system prompt and the default envelope — thread `stableContext` into `buildSystemPrompt` there, and in `turns.ts`'s explicit `buildAgentContextEnvelope` call site pass/receive the split accordingly (the envelope builder drops the `memory.context` section, keeping retrieved-only).
- `buildSystemPromptPreview` (`agent.ts:277`, used by the Settings/About preview RPC) keeps working with the option omitted — preview shows the stable structure without live memory.
- Redaction posture is unchanged: everything entering the system prompt already passed `writeWorkingMemoryState`/`writeCoreMemoryAtomic` redaction on the way into storage.

### 6c. Interaction with item 7

Do this **before** item 7's Phase A dogfooding day: with ~9k chars/turn of duplicate envelope removed, context growth per turn drops sharply, and the rollover-frequency measurement Phase A depends on would otherwise be distorted by a cost this item deletes.

### Regression tests

1. The envelope built with a populated core + working state contains **no** `Core memory:` / `Working memory:` sections; retrieved/screen/handoff sections unchanged.
2. `buildSystemPrompt({ memoryState })` renders the block after the soul; omitted option renders no block.
3. `renderStableMemoryState` output contains artifacts-first working memory (depends on item 2's render order).
4. End-to-end shape: `runBondQuery`'s composed prompt (via `composePromptWithContext`) contains the user text and the slim envelope, and the session-persisted user message no longer embeds core/working state.

**Done when:** after a rebuild and a few turns, the newest user messages in the live session JSONL average < 2,500 envelope chars (measure with the script in Methods), while `grep 'bond-memory-state'` on the JSONL returns nothing (the state never lands in history).

---

## Work item 7 — The rollover question, then the handoff (~half a day, **gated**)

> **Status: implemented 2026-07-21 — both phases.** Phase A: ratio 0.8 → 0.92 plus `scheduleEpochReflection` (200 seqs). Phase B was built alongside rather than gated: with working memory naming artifacts deterministically, the state snapshot costs nothing to render and beats the prose tail whether rollover fires weekly or hourly. Phase A's dogfooding still decides whether rollover frequency is acceptable — it no longer gates the handoff.

**Do not build the structured handoff first.** Finding 1 (R2) shows Pi compacts in place at ~75% of the window with good summaries and the session survives; Bond's rollover at 80% destroys sessions to solve the same problem worse. The cheapest correct move may be to make rollover a rare backstop rather than to improve its handoff.

### Phase A — decide (measurement + one setting change, ~1h)

1. Raise `DEFAULT_SOFT_LIMIT_RATIO` (`epochs.ts:8`) from `0.8` to `0.92`. Rationale: observed Pi compaction fired at 75.3% of the window; at 0.92 Bond's rollover only fires if Pi's compaction fails to keep up (a genuine backstop).
2. **Consequence to handle in the same change:** if rollovers become rare, the rollover-driven `memoryFlush` (reflector) almost never runs, and epochs can live for days. Re-home the reflection cadence: add `scheduleEpochReflection` beside `scheduleEpochObservation` in `service.ts` — same queue, same shape, firing when `toSeq - epoch.reflectedThroughSeq >= REFLECTION_SEQ_INTERVAL` (start at 200). With item 1's additive core this is safe to run mid-epoch. Wire it into `turns.ts` next to the observation call (`turns.ts:218`).
3. Dogfood for a full working day — **after item 6 has landed** (removing ~9k chars/turn of envelope changes the growth rate this measurement depends on) — then run the three queries in [The honest end-to-end check](#the-honest-end-to-end-check). Decision rule: if no `context_soft_limit` rollover fires during a normal day and context stays bounded by Pi's compaction, **rollover is a backstop and the prose handoff can stay as-is** (it will fire once a week at most, and items 1+2 already fixed what it carries — the system prompt's working memory now names artifacts). If rollovers still fire routinely, proceed to Phase B.

### Phase B — structured handoff (only if Phase A says rollovers remain routine)

Replace `buildEpochHandoffContext`'s prose tail (`agent.ts:201`) with a state snapshot rendered from the now-reliable working state:

```
Epoch handoff (previous context closed: context_soft_limit)
Goal: <working.goal>
Working on:
  - [library] /…/058eb00f-….md — "Studio trunk audit — July 21, 2026"
  - [issue] STU-2085
Active skill: audit-triage-feedback
Checkpoint: audit item 8 of 18 filed; next is 9
Open threads: …
Pi summary (may be stale): <last {"type":"compaction"} record from the closing session's JSONL, if any, truncated to 2,000 chars>
--- last 4 exchanges (verbatim) ---
```

Harvest notes: the closing epoch row carries `pi_session_file`; read the file, scan for the **last** line whose JSON has `type === "compaction"`, take `.summary`. Treat as supplementary — R2 measured that only 3 of 16 sessions have one, the incident session had none, and the ones that exist can be 60+ minutes stale. The working-state snapshot is the load-bearing content; do **not** build an LLM synthesis fallback (`runPiTextPrompt`) unless dogfooding shows the snapshot alone is insufficient — items 1+2 exist precisely so no model call is needed at handoff time.

**Tests (Phase B):** handoff render includes artifact path + skill + checkpoint given a populated working state (the literal 2026-07-21 regression); compaction harvest parses a fixture JSONL and tolerates absent/malformed records; handoff without any compaction record still renders the full snapshot.

---

## Verification plan

1. **Replay the failing ranges.** The transcript ranges behind all 36 logged failures are still in the database. After item 1, re-run `observeAndPersistRange` over the currently stuck range (`fromSeq 833`, `toSeq` = current max) and assert a `workingState` write, a marker advance, and a ledger row.
2. **Monotonic marker property test** (item 1, test 6) and **seeded markers** (item 1, test 9): no observation or reflection range ever starts at seq 1 on a non-empty database.
3. **The incident regression, memory side** (item 2, test 6): audit-doc artifact + skill render into the prompt state.
4. **The incident regression, search side** (item 3, test 4): the literal recovered query `"on to 9" Studio audit` returns the morning's audit messages.
5. **Recall retarget** (item 4): `"on to 9"` + populated goal ⇒ non-empty retrieval query; explicit-verb path unchanged; empty-everything still short-circuits.
6. **Health reports the incident** (item 5): feed the ledger the real failure sequence, assert `memory.health` shows the freeze and the streak.
7. **Envelope slimming** (item 6): live session JSONL averages < 2,500 envelope chars per user message; core/working state absent from session history.
8. **`npm run test:run` green after every item** — enforced by pre-commit.

### The honest end-to-end check

None of the above proves the product claim. The real test is a full working day — audit-style, artifact-centric, many short messages — followed by:

```bash
sqlite3 bond.db "select count(*) from epochs where started_at > date('now') and end_reason='context_soft_limit';"
sqlite3 bond.db "select json_extract(value,'$.updatedAt') from settings where key='memory.working';"
bond memory status
```

Target: rollovers do not accelerate through the day (post-item-7A: near zero), working memory is never stale by more than one observation interval (24 seqs), and no consecutive-failure streak reaches 2 without `bond memory status` and the MemoryView badge showing it. Anything short of that and Bond is still degrading quietly — just more slowly.

---

## Out of scope (separate tickets)

- **Answered `ask_user_question` cards are invisible after the fact** — the question lives only inside the collapsed activity row, so the transcript reads as though Bond said nothing between two user messages.
- **A mid-turn answer renders above the message it answers** — the assistant row is minted at turn start (seq 859) and the derived answer bubble lands after it (seq 860).
- **daemon.log lines carry no timestamps** — every log-forensics step in this investigation was bounded by line position instead of clock.

## What was checked and found healthy

- **Skills load correctly.** All four skills parse; `audit-triage-feedback` exists and is well-formed. Skill routing was not the failure.
- **The audit document is intact** — 27 KB, 18 `### N.` headings.
- **The daemon did not crash** during the session; no socket-claim exits or unhandled errors in the window.
- **Pi transport is as pinned** — all sessions record `provider: openai-codex`, transport SSE per `pi/runtime.ts`.
- **`ask_user_question` worked as designed** — the card was minted, parked, resolved by a composer-typed answer, and mirrored; the complaint is rendering, not protocol.
- **Pi sessions resume across daemon restarts** (R3) — `runPiBondQuery` reopens the existing JSONL via `findSessionFile` + `SessionManager.open` (`pi/runtime.ts:357, :453–454`). A daemon restart is not a context-loss event; only rollover is.
- **Memory-item dedup works** (R3) — 146 items, 144 distinct 60-char prefixes; `findActiveMemoryByText` is doing its job.
- **The FTS index itself is well-built** (R3) — bm25 ranking, unicode61 with diacritics folding, and tool outputs indexed via `searchableText` (activity events, 4k cap). Finding 12 is entirely in the query construction and result filtering, not the index.

---

## Methods

Sources, in order of authority:

| Source | Path |
|---|---|
| Bond database | `~/Library/Application Support/bond/bond.db` |
| Pi session transcripts | `~/Library/Application Support/bond/pi/sessions/*.jsonl` |
| Daemon log | `~/.bond/daemon.log` |
| Core memory | `~/Library/Application Support/bond/memory/core.json` |
| Working memory | `settings` row, key `memory.working` |

**[measured] Corpus at R2:** 8,445 messages (max seq 867), 144 memory items, 16 Pi session files, 12,573 log lines.

Key reproduction queries (all re-run during R2):

```bash
# Epochs, close reasons, markers
sqlite3 -header bond.db "select id,status,started_at,ended_at,end_reason,context_tokens,context_window,
                                observed_through_seq,reflected_through_seq from epochs order by started_at desc limit 10;"

# Turns per epoch + opening context (first completed turn per epoch)
sqlite3 -header bond.db "select epoch_id, count(*), min(started_at) from turns group by epoch_id order by 3;"

# sourceId failure taxonomy
python3 - <<'PY'
import re
log = open('/Users/shaun/.bond/daemon.log', errors='ignore').read()
tokens = [t.strip() for chunk in re.findall(r'unknown sourceIds: ([^;\n]+)', log) for t in chunk.split(',')]
numeric = [t for t in tokens if re.fullmatch(r'\d+', t)]
print(len(tokens), 'bad tokens;', len(numeric), f'numeric ({100*len(numeric)/len(tokens):.0f}%)')
PY
# R2: 160 bad tokens; 149 numeric (93%)

# Compaction records (R2: 3 files, 1 each)
grep -c '"type":"compaction"' ~/Library/Application\ Support/bond/pi/sessions/*.jsonl | grep -v ':0'

# Recall gate suppression (R2: 176 of 1245, 14%)
# — reimplement shouldRecallMemory verbatim over: select text from messages where role='user' and created_at > '2026-07-18'

# First audit-doc mention in the 17:05Z session (R2: line 93, 18:27:36Z, role toolResult)
# — scan the session JSONL for 'studio-trunk-audit' or '058eb00f'
```

Notable R2-only measurements: current session peaked at 204,894 tokens (75.3% of 272,000) before Pi's in-place compaction at 18:33:24Z dropped it to 62,696 with the epoch still alive; the envelope seeded at 17:05Z is 10,893 chars, contains `"ok, on to 7!"` and `"a Library markdown file"`, and contains neither `058eb00f` nor `audit-triage-feedback`; seq 696's UUID is `3632f4a9-…` while rejected token `696c7b2e-…` matches no message row (hallucinated); Pi tool argument names verified from session JSONLs (`read`/`write`/`edit`/`ls`/`grep`/`find` all take `path`).

R3 measurements (second pass, same day):

```bash
# Finding 10 — whole-history batch sizes (what unseeded markers actually send)
sqlite3 bond.db "select count(*), sum(length(text)) from messages
                 where seq between 1 and 832 and role in ('user','bond')
                   and text is not null and trim(text) != '';"
# → 521 messages, 151,823 chars (~38k tokens) — fa3a413b's first observation
# → 519 / 149,965 for seq 1–829 — 81932210's rollover reflection

# Finding 11 — envelope duplication in the live session
# For each user message in the session JSONL, measure the <bond-context-envelope> span:
# → 14 of 14 user messages carry one; min 8,664 / avg 9,146 / max 10,655 chars; 128,055 total (~32k tokens in 14 turns)

# Finding 12 — the recovered incident queries (from the 17:05Z session JSONL toolCall records)
# → {"query": "\"on to 9\" Studio audit"}      at 18:26:34Z
# → {"query": "\"9\" \"Preview\" audit finding"} at 18:26:39Z

# Finding 12 — post-LIMIT crowding, live
sqlite3 bond.db "SELECT m.role, m.kind FROM message_fts f JOIN messages m ON m.id=f.message_id
                 WHERE message_fts MATCH '\"audit\" \"item\"'
                 ORDER BY bm25(message_fts), m.seq DESC LIMIT 8;"
# → 6 of 8 rows are meta/activity — discarded by history_search's post-filter
# A plain '\"studio\" \"trunk\" \"audit\"' MATCH ranks user/bond seqs 678/680/689/692/799 in its top 8 —
# the morning discussion was findable; the incident queries' AND semantics made it unreachable.
```
