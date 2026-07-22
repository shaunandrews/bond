# Desk — Fixing Attribution

> Written after the first full day of Desk running live (2026-07-21). Every number below is measured from `bond.db`, not estimated. Prior-art claims are from source, with repo links.
>
> **Revision 2, same day** — after a full code-verification pass. Every mechanism below was traced to source and held up; three claims are corrected inline (foreign keys, the dual-linked captures, the "missing" candidate column); and the pass surfaced a second layer of defects the first draft missed — a smoothing window that doesn't smooth, inference that can overwrite user corrections, signatures that fork on extraction route, a dead "immediate" inference path whose call ceiling therefore gates nothing, and the 24-hour back-fill horizon behind the silently abandoned day. All are folded into Phases 0–3, plus a new Phase 1.5 (inference hygiene) and an appendix of adjacent findings. The db numbers were independently reproduced before revising.
>
> This plan does not revisit the product rules in `plans/desk.md`. Those held up — the research validated them harder than expected. What failed is the attribution machinery underneath them.

## The complaint

> "Desk is running, but it seems to always think I'm working on Bond. And, well, it's probably because I've been using Bond all day, but to work on Studio."

That is exactly right, and the mechanism is worse than the symptom suggests.

## What actually happened

The Bond app reports as `appName: "Electron"`, `windowTitle: "Bond"`. Every capture of it hashes to **one** resource signature:

```
7b50ab3a161235d48e7adb68b2007053   →  221 segments, 102.0 minutes, 22.1% of the day
```

One classification, made once at 04:41, governed the largest block of the day. What the screen actually said during those minutes:

```
Electron Edit View Window … In Studio  Studio Workbench (Agentic UI)
  … apps/u/src/ui-classic/components/ses · Add queue effect controls
  … linear.app/a8c/issue/STU-2079/
```

Studio work, filed under Bond, for 102 minutes.

### It is not one bad guess — it is four strings

| pattern | field | len | hits | thread |
|---|---|---|---|---|
| `bond` | title contains | 4 | 305 | Bond |
| `studio` | title contains | 6 | 298 | Studio |
| `STU-` | title contains | 4 | 150 | Studio |
| `8be08b12…` | resource exact | 32 | 103 | Studio |

**Four matchers carry 67% of all 1,273 hits.** `title contains "bond"` also claimed *"James Bond in Diamonds Are Forever – Book vs. Movie"* — 4 minutes of a film review, filed as project work. ActivityWatch has [the identical open complaint](https://forum.activitywatch.net/t/1471): YouTube videos with a program's name in the title get categorized as using that program.

The remaining 171 matchers are mostly dead weight — **122 of 175 (69.7%) have never fired once**, and 57 of them point at a thread the model invented called `one-off`, whose actual contents are `Ghostty/Fable`, *It's Always Sunny S16·E7*, `Macintosh HD Info`, and `r/adultswim`.

### The day is decided by a handful of decisions

| Coverage | Share of the day's 463.5 min presence |
|---|---|
| Top 1 signature | **22.1%** |
| Top 5 | **50.1%** |
| Top 10 | 64.6% |
| Top 20 | 79.2% |

213 distinct signatures; 125 model calls. Half the day is five signatures that each needed the model exactly once. The call budget — 125 calls, ~121k prompt tokens, **57.8 minutes of cumulative latency** — is spent almost entirely on the long tail that accounts for ~17% of time.

### 68% of the day has no task content in its title

| Title shape | minutes | % of day |
|---|---|---|
| Empty | 46.8 | 10.1% |
| ≤ 12 chars (`Bond`, `Studio`, `ChatGPT`, `Figma`, `Codex`, `Fable`) | **314.3** | **67.8%** |

The three largest signatures — 186 minutes, 40% of the day — are literally the strings `Bond`, `Studio`, `ChatGPT`.

### And the fallback signal does not work either

The obvious fix is to read the OCR text instead of the title. **Measured, it carries almost no information.** `sense_captures.text_content` is whole-screen OCR (`src/main/sense.ts:129` requests `types: ['screen']`), so every visible window bleeds into every capture:

| token | share of today's 25,118 captures |
|---|---|
| studio | **89.2%** |
| wordpress | 70.8% |
| bond | 51.3% |
| STU- | 50.2% |
| linear | 47.4% |

Measured as *lift* over that ambient base rate, the three signatures covering 40% of the day have **no token above 1.30×**. Their text is statistically indistinguishable from screen noise. Feeding it to the model is feeding it the room, not the work.

> **Hard line.** Whole-screen OCR text is not evidence of what the focused window is about. It may support a note; it must never resolve an attribution on its own.

---

## Why it cannot self-correct

Six independent mechanisms, each individually fatal. The first three fell out of the data; the second three fell out of the code review.

### 1. A resolved segment is invisible forever

```
capture → segment (attribution_state = 'unresolved')
        → resolveMatcher() hits the cached rule
        → attributeSegment() sets attribution_state = 'resolved'
        → listUnresolvedSegments() selects only ('unresolved','failed')
```

There is no decay, no re-validation, no sampling, no confidence review. `hits` is incremented but **never read by any decision**. Once a signature has a matcher, that resource can never reach the model again. A wrong guess at 04:41 is load-bearing at 20:41.

### 2. The Ask loop is a closed cycle that cannot converge

15 questions today: **3 answered by hand** (all before 13:05), **11 auto-accepted by silence**, 1 rejected. The last twelve alternate on a fixed ~23-minute period:

```
Studio → Bond → Studio → Bond → Studio → Bond …
```

Forever. Every one auto-accepted. And none of the three outcomes can teach:

| Outcome | What it writes | Durable rule? |
|---|---|---|
| Silence (11×) | `auto_accepted` + `commitSwitch` | **None** — by design, correctly |
| Accept (3×) | `accepted` + `commitSwitch(confidence: 1)` | **None** — accepting never writes or confirms a matcher |
| Reject (1×) | `rejected` + `resolved_at` | **None** — see below |

**Rejection is a no-op in production.** `rejectQuestion` requires `question.resourceSignature` and short-circuits without it (`questions.ts:224`) — before `recordRejection`, `dropInferredMatchersForThread`, and `clearSegmentAttribution`. *Corrected on code review:* the columns are not missing — `desk_runtime` has carried `candidate_resource_signature` **and** `candidate_matcher_id` since the schema was born (`db.ts:999-1002`). What's missing is any code path that writes them: `evaluateSwitch` persists only `candidateThreadId` / `candidateSince` / `candidatePresenceSeconds` (`segmenter.ts:387-391`), and a repo-wide search finds **no non-null assignment to either column anywhere**. So every question is created with `resource_signature = NULL`, `desk_suppressions` is empty and **structurally cannot fill**, and the three-strike rule has never executed. Worse than the first draft knew: the short-circuit also returns *before the block fall-back* (`questions.ts:239-244`), so rejecting a NULL-signature question marks it rejected while **leaving the block attributed to the very thread the user just rejected**.

Result after a full day and 15 asks: **175 matchers, 0 confirmed.** There is no code path from an Ask to a confirmed rule.

### 3. The Ask does not gate the switch, and answering it commits twice

`handleSwitch` raises the question and early-returns *on that tick* — but asking neither clears nor freezes the candidate. On the **next** 2-second tick `evaluateSwitch` still returns `switch`, `assertionAllowed()` is now false (the ask spent the budget), the `if` is skipped, and control falls through to `commitSwitch` at `worker.ts:113` with the question still pending. That first commit calls `clearCandidate`, so when accept/expire later runs `sinceIso = runtime.candidateSince ?? question.createdAt` (`questions.ts:189, 270`), it finds null and calls `commitSwitch` a **second** time from `question.createdAt` — earlier than the block already open. A third variant of the same bug: `candidateSince` is *live mutable state* — if the leader flips to a different thread between ask and answer, accepting thread A's question dates A's block from thread B's candidate clock.

That produces the four blocks whose `ended_at` precedes their own `started_at`:

| block | started | ended | delta |
|---|---|---|---|
| `a45d04a2` | 13:23:14 | 13:15:56 | **−438 s** |
| `f21a815c` | 14:12:04 | 14:05:22 | −402 s |
| `1afae948` | 14:58:38 | 14:52:09 | −388 s |
| `c1f3e290` | 18:39:32 | 18:34:42 | −290 s |

Not a clock-vs-capture-time bug. A double-commit, and every instance is caused by an Ask. `updateBlock` (`store.ts:257-295`) writes whatever `ended_at` it is handed — there is no ordering guard anywhere.

### 4. The smoothing window doesn't smooth

`rollingWindow` (`segmenter.ts:305-329`) selects segments *overlapping* the window and sums their **entire lifetime** `presence_seconds` — a segment that started 25 minutes ago and overlaps the window by one second contributes all 25 minutes. The comment insists it smooths "over a rolling window of time, not a count," but pre-window presence dominates, so whichever thread owns the longest-lived overlapping segment wins regardless of what the user is doing *now*. This is the exact stale-leader failure the smoothing was written to prevent, running in the opposite direction.

### 5. Inference can overwrite the user

`runInferenceBatch` marks segments `queued`, awaits the model for up to 120 seconds, then `apply()` re-fetches each segment and attributes it with **no check that it is still `queued`** (`inference.ts:342-427`) — while the metadata-only fallback loop directly below it *does* check (`:432-433`). Reassign a block during the model await and the model's answer silently reverts your correction. The authority matrix protects matchers from exactly this; nothing protects the segments. Same defect class in notes: the three failure paths (`model_error` / `empty` / `redacted`, `notes.ts:170-186`) stamp `note_status='failed'` without re-checking for a concurrent user edit — flipping `edited → failed`, which retention then refuses to graduate. And a `failed` note is terminal: `listBlocksAwaitingNote` selects only `'none'` (`store.ts:496-510`), so one transient Pi outage permanently loses that block's re-entry note.

### 6. One window, two signatures

`signatureForCapture` folds extracted paths into the hash, but `extractPaths` returns `[]` unless `text_source` is accessibility (`signature.ts:97-99, 124-129`). The same window therefore hashes **differently depending on which extraction route the capture happened to take** — flipping as OCR and AX alternate, spuriously closing/reopening segments (`segmenter.ts:236`), and forking the matcher/suppression key space so the fast path misses on a resource it already learned. The volatile-pattern strip has holes in the same vein: dev-server ports (`:3000` — the clock regex requires digits *before* the colon), bare percentages (`Compiling 34%`), and dates in titles all fork signatures.

---

## The block is also the wrong unit

| | count | of 33 |
|---|---|---|
| Block's thread is a **minority** of its own segments' presence | **19** | **58%** |
| Block's thread isn't even the **plurality** | **16** | **48%** |

The flagship: `ce950f29`, a **47-minute block labelled "Bond" in which the Bond thread accounts for 32 seconds.**

And the re-entry notes are right while the attribution is wrong — *in the same row*:

> Block `0d874b47` — thread **Home Internet** — note: *"Still working on Studio Workbench's Suggested prompts / Thinking indicator layout"*

The note generator reads 30 minutes of linked text and gets it right. The attribution reads the window title and gets it wrong. **That disagreement is the single most useful signal in the database** — it says the information exists and the attribution path is the part that is not looking at it.

Two more structural numbers:

- **241.3 minutes — 34% of all recorded presence — sits in no block at all.**
- **Not one segment in the entire day exceeds 10 minutes.** 58% are under 10 seconds. The median unit of observation is 13 seconds of app-switch thrash, against a design that claims to operate at an 11-minute "working sphere" altitude.

---

## What the prior art says

Full survey in the research appendix; the load-bearing findings only.

### Everyone has this exact problem, and they say so plainly

> "they can usually tell you what applications you have open but not why you had them open." — [HN](https://news.ycombinator.com/item?id=40980500)

> "When I boot my machine I automatically load Safari, Calendar, Mail, Omnifocus and DEVONThink. But I use all those tools for work and play projects and the information on how much time I am in those apps doesn't tell me what I was using it for." — [Mac Power Users](https://talk.macpowerusers.com/t/10380/21)

### The systems that survive rule changes do not store classifications

**arbtt** ([nomeata/arbtt](https://github.com/nomeata/arbtt)) splits capture from interpretation into two binaries. `arbtt-capture` appends raw samples and has never parsed the rules file. `arbtt-stats` applies rules to **all history on every invocation**. From the manual:

> "Everytime the categorizer (arbtt-stats) runs, it applies categorization rules to all recorded data and tags it accordingly."

The author's reason:

> "One big advantage of this approach is that you do not need to know in advance what queries you are interested in. Since the rules are applied when you are evaluating your data, and not when recording it, you can add more tags and forgotten special cases later."

**ActivityWatch** ([source](https://github.com/ActivityWatch/aw-webui/blob/master/src/queries.ts)) does the same thing as a stateless server-side transform — the client serializes the whole category list into every query string and the server runs `categorize(events, …)` at read time. Events on disk never carry a category.

**ManicTime** keeps the distinction as a product concept: *"Autotags are just rules, so they will work on any day in the past"* versus manual tags, which stay fixed.

**Nobody in the survey revisits a stored classification.** Not one system has decay, re-review, confidence gating on a cached decision, or sampling. What looks like revalidation is always total re-derivation from deterministic rules — which cannot express uncertainty, because there is no confidence value anywhere in any of those rule engines.

The closest architecture to Desk's is **Rize**, which after 2 minutes in an uncategorized app calls an LLM and **writes a persistent tracking rule** — with no confirmation step, no suppression, and no way for the rule to be wrong twice differently. That is Desk's current design, shipped commercially, and it is the failure we measured.

### The container problem has exactly one robust fix

| Approach | Shipped and works? |
|---|---|
| **Editor/terminal reports file path + git repo** | **Yes — the only robust fix.** WakaTime's detector: `.wakatime-project` → projectmap → **revision-control repo detection** |
| **Browser extension / AX for per-tab URL** | **Yes** |
| **Structured tokens injected into the window title** | Yes, with per-app opt-in |
| **arbtt's `any window` — co-present windows as evidence** | **Yes, and unique to arbtt** |
| Process args / `lsof` open files | No — proposed in AW [#504](https://github.com/ActivityWatch/activitywatch/issues/504), closed stale |

Worth knowing: ActivityWatch has captured editor `project` (git root folder name) since ~2019 and **still cannot categorize on it** — the data goes to a separate bucket that `categorize()` never sees. [The fix PR was closed unmerged on 2026-06-03.](https://github.com/ActivityWatch/aw-webui/pull/851) Its own docs tell users to *"use a browser extension that adds the URL to the window title"* because the proper path doesn't reach the classifier. **Having the signal is not the same as using it.** That is the trap Desk is currently in.

### Screen-capture systems have not solved this

**screenpipe** shipped an `ocr_text_embeddings` table, never wrote a row to it, and dropped it 14 months later — migration comment: *"created for an embedding pipeline that was never implemented."* Its project grouping is an LLM over `GROUP BY app_name` with no persistence: run it twice, get two different answers. **OpenRecall**'s `main` branch does not run, and its embedding search has been broken by a dtype bug since May 2025.

Both are searchable logs, not classifiers. The two projects that tried classification over screen text abandoned it.

One transferable datapoint: screenpipe moved from **OCR-first to accessibility-first** in Feb 2026, claiming *"100x less resource usage, 100% data accuracy."*

### What Desk is doing that nobody else does

Two things, and they should be protected:

1. **Co-presence over time.** arbtt's `any window` is instantaneous only. Desk's rolling presence window is the only mechanism in the survey that reasons about *which resources keep alternating within a few minutes, therefore one thread*.
2. **Durable negative evidence + a confirmation gate.** Suppressions and `confirmed=0 → confirmed=1` have no analogue anywhere. Expect no design guidance and no reusable failure list — this part is genuinely new, which is also why it is the part that is currently inert.

---

## The plan

> **IMPLEMENTATION STATUS — 2026-07-21.** Phases 0, 1, 1.5, 2, and 3 are all implemented, tested, and green (2066 tests, typecheck clean, daemon + CLI + native helpers all build). Phase 4 remains unspecified by design (re-measure after Phase 2 data). Load-bearing outcomes to know before reading the phase detail below:
> - **Signature is now route-independent** (`bundle + title`, `SIGNATURE_VERSION = 2`); paths/URLs are ranked matcher *fields*, never hash inputs. A version-gated boot migration swept the old inferred matchers/junk threads once (free: 0 confirmed rules existed).
> - **Attribution is a derived projection** (`desk_labels` + `desk/labels.ts`). `attributed_thread_id` is a cache; a **user** label is frozen, matcher/model labels re-derive when `rules_version` bumps (any user rule change / thread merge/rename/archive). Correction is retroactive via a bounded background sweep; the notch still reads the cache, so the hot path is unchanged.
> - **The learning loop is closed**: `candidate_resource_signature`/`candidate_matcher_id` are now populated (they were dead), so rejection actually suppresses; rejection follows batch provenance to drop the broad matcher a model batch wrote; a (resource, thread) pairing answered today is not re-asked; questions expire even when Desk is off; the immediate inference path is wired behind its now-real budget.
> - **AX URL** (`--url` → `kAXURLAttribute`, Chromium behind `AXManualAccessibility`) is implemented end-to-end in TS + the native helper (which compiles), but is **probe-gated on live macOS** — it produces no data until you run the app and confirm Chromium exposes the URL; Safari-plus-title is the honest fallback.
> - **Re-baseline every presence-derived number** before trusting Phase 4 analysis: the rolling-window and capture-rate changes moved them all.

### Principle: separate observation from interpretation

Desk currently bakes an interpretation into `desk_segments.attributed_thread_id` at capture time and can never revisit it. Every system that handles correction well does the opposite.

**Attribution becomes a derived projection, not a stored fact.**

- `desk_segments` keeps only what was *observed* — signature, evidence, presence, timing. Those are deterministic and fine as they are.
- A new `desk_labels` table records every *interpretation* — from a matcher, from the model, or from the user — with its source, confidence, and the `rules_version` in force when it was made.
- `attributed_thread_id` stays, demoted to a **cache** with a `derived_at` / `rules_version` stamp. Bump the version and the cache is stale; re-derivation is a background sweep, not a migration.

This is what makes everything else affordable. A wrong guess stops being permanent, so the system is allowed to guess.

**Keep the live path exactly as fast as it is.** The notch panel reads the cache. Nothing in the hot path changes.

**Say the reversal out loud.** This inverts a shipped, documented invariant: `desk/store.ts`'s header and CLAUDE.md both state *"attribution is a snapshot, not a join, so correcting a matcher never rewrites history,"* and tests assert it. That stance was right about protecting history from *matcher edits* and wrong about everything else. The new rule splits it: **user labels are frozen forever; matcher and model labels re-derive.** Flip the store docs, the CLAUDE.md line, and the snapshot tests in the same PR as the schema — a doc that contradicts the code is worse than either alone.

### Hard lines this plan adds

1. **Whole-screen OCR text never resolves an attribution alone.** It may raise or lower confidence in a label supported by structured evidence; it may feed a note. Measured lift says it cannot carry a decision.
2. **A container is defined by observation, not by a list.** `tooBroadReason` missed `title contains "bond"` because it compares against `appName`, which for a dev build is `Electron`. A hardcoded bundle list will keep missing cases. Define it from data: a normalized title that covers more than *N%* of a day across more than *M* distinct co-presence contexts is a container name, and is barred from naming a thread or backing a `contains` matcher.
3. **The model labels; it does not legislate.** A model verdict writes a `desk_labels` row scoped to that segment. A *rule* is promoted only on user confirmation, or on N independent agreeing labels across distinct sessions.
4. **Every Ask outcome teaches something.** Silence still teaches nothing durable — that rule stays. But accept must confirm a rule, and reject must suppress one. An Ask that can produce neither should not be asked.
5. **A URL is a secret-bearing string.** Persist and transmit **origin + path only**; strip query and fragment before anything downstream sees them. `redact()` pattern-matches known token shapes — it cannot recognize an opaque secret in a query parameter, so the only safe query string is an absent one.
6. **The user's write always wins, at every layer.** Any asynchronous apply — a model return, a sweep, a retention pass — must prove the row it is about to write hasn't been touched by a newer user action before writing. Today inference's `apply()` and the note writer's failure paths both violate this (mechanism 5 above). The matcher authority matrix got this right; segments and notes get the same guarantee.

---

### Phase 0 — Stop the bleeding (~1 day)

> **STATUS: implemented 2026-07-21.** All ten items landed with regression tests; full suite green (2035 tests), typecheck clean, daemon + CLI bundle. Behavioural note for the next phase: the Ask now **commits optimistically at raise time** and accept/reject/expire only *adjust* that block — the old "ask first, commit on answer" contract is gone (worker `handleSwitch`, `questions.ts`). The rolling window credits **in-window presence only** (linear apportionment), which changed switch behaviour day one — re-baseline every presence-derived number before evaluating Phase 1. The inference reach-back is now the **retention window**, not 24h; the sweep has its own hourly ceiling (`SWEEP_CALLS_PER_HOUR`). Note retries use two new `desk_blocks` columns; the inference ledger uses three new `desk_metrics` columns (`resolved`/`failed`/`error`) — `bond desk stats` does not yet surface them (folded into Phase 2's counter-fixes).

Independent of any redesign. All of these are bugs, and every fix lands with a regression test (house rule). The first draft knew four; the code review made it ten.

**Integrity —**

1. **Sweep the orphan links; foreign keys are already on.** *Corrected:* `db.ts:24` has set `PRAGMA foreign_keys = ON` since ce572cb (2026-07-20) — but the serving daemon predates the bundle on disk (`bin/bond status` flags it), which is how a full FK-off day got measured. Restart it. The historical damage stands either way — SQLite never retro-validates: **12,454 orphan links**. *Second correction:* those "7,724 captures linked to two competing segments" have **zero live competition** — every multi-link is one live segment plus orphan links to segments that no longer exist, so the sweep is a plain delete with no arbitration. Repair the four negative-duration blocks in the same migration, and add a startup `foreign_key_check` (or `bond desk doctor`) so an orphan class can never silently re-accumulate.
2. **Fix the Ask double-commit — all three variants.** Asking must freeze or consume the candidate so the next tick can't fall through to `commitSwitch` (`worker.ts:113`) while the question pends. Recommend: commit optimistically at ask time (matching Desk's optimistic-reassignment stance) and make accept/reject/expire *adjust* that block — never call `commitSwitch` again. Derive the adjustment time from the question's own stamped block, **never from live `runtime.candidateSince`** (`questions.ts:189, 270`), which can belong to a different candidate by answer time. Guard `updateBlock` so `ended_at` can never precede `started_at` (`store.ts:257-295` currently writes anything).
3. **Closed blocks stay closed.** `addBlockPresence` (`store.ts:297-301`) and segment creation (`segmenter.ts:239, 250, 258`) never check `ended_at` — 11 of 34 blocks have `presence_seconds` exceeding their own wall-clock span, one by **4.18×**, with segments landing up to 20 minutes after `ended_at`. Refuse presence credit and segment attachment on an ended block; open a new one instead.

**Behavior —**

4. **Make the rolling window sum in-window presence only** (mechanism 4). Clip each overlapping segment's contribution to the presence it accumulated *inside* the window. This changes switch behavior day one and Phase 1's evaluation depends on it.
5. **The user's write wins** (mechanism 5, hard line 6). `apply()` re-checks `attribution_state === 'queued'` per segment before writing — the fallback loop at `inference.ts:432` already shows the shape. Notes: failure paths re-check `note_status !== 'edited'` before stamping `failed`, and `failed` gets `retry_at` backoff instead of being terminal.
6. **Cut the capture rate.** **20,457 `app_switch` captures against 775 actual app transitions** — 26× over; 93% of inter-capture gaps are under 2 seconds; one 4-minute segment holds 247 captures. Debounce app-switch triggers against the *configured* interval — which on this machine is **5 s, not the 15 s default**, so hardcode nothing. Two riders: this is a **Sense** change (the redundancy burns OCR queue and storage regardless of Desk), and it reshapes the inter-capture gap distribution that `presence_seconds = min(gap, 2×interval)` is derived from — re-baseline presence-derived numbers after it lands.

**Honesty —**

7. **Kill the 24-hour back-fill horizon and give inference a ledger.** Root cause found: `BACKFILL_HORIZON_HOURS = 24` (`inference.ts:299-300`) makes any older segment invisible to the sweep forever — zero attempts, zero errors, exactly the abandoned 2026-07-19. Page back-fill through the full retention window instead, and write one ledger row per batch — the `memory_runs` pattern, which exists because silence was the meta-failure of the 2026-07-21 memory incident: kind, segments in/resolved, model error, tokens, duration. `bond desk stats` reads it.
8. **The call budget is fiction — make it real.** `runBatch('immediate')` has **zero callers**; the 6/hour ceiling gates a path that never runs, while the sweep — the only live path — is unbudgeted (`catchUp` loops up to 200 rounds, `worker.ts:174-181`). That is how one hour of back-fill burned 81 calls. Give the sweep its own hourly ceiling now; Phase 3 decides whether the immediate path gets wired or deleted.
9. **Register `desk.changed` at server init, not inside the worker factory** (`server.ts:306-315`). Today, if Desk was never running this boot, every mutation — reassign, rename, merge, answer, todos — broadcasts into an empty listener list and panels go stale. That is precisely the read-only-while-Sense-off state the panel is designed to be usable in.
10. **`bond desk answer` with a forgotten verdict must print usage, not reject.** `accepted = !!verdict && startsWith('y')` (`desk-helpers.ts:53`) turns a typo into a rejection — which Phase 3 makes a *durable negative rule*. A missing verdict is a usage error, never an answer.

### Phase 1 — Recover the signal that already exists (1–2 days)

Three signals Desk has and discards, plus one schema decision that is free today and never will be again. This is the highest value-per-line work in the plan.

0. **Change the signature schema once, now, deliberately.** Three independent findings all force a signature change: the extraction-route fork (mechanism 6 — a signature must never depend on `text_source`), the volatile-pattern holes (ports, bare percentages, dates), and folding in the URL (step 2 below). Every one of them changes every hash — and everything durable is keyed on hashes: matchers, suppressions, the measured baselines. **Today the break costs nothing: 0 confirmed matchers, 0 suppressions — nothing user-authored is keyed on the old values.** Make all three changes in one break, and sweep the 183 inferred matchers (125 never fired) plus the junk threads in the same migration rather than leaving zombies keyed to hashes that will never occur again. The moment Phase 3 ships, confirmed rules and suppressions make signature changes expensive forever — so also stamp a `signature_version` into `desk_runtime` now, so the *next* change (there will be one) can invalidate instead of corrupt.

1. **Persist co-visible window titles.** `bond-window-helper` already returns `{name, bundleId, title, layer, frame, active}` for every on-screen window. `src/daemon/sense/controller.ts:162` reduces it to bare app names:

   ```js
   JSON.stringify(preSnapshot.windows.map(w => w.name))
   ```

   Keep the titles (redacted, bounded — top N by layer, with frontmost flag and area — ordered by layer). While Bond was frontmost, Figma was showing *"Studio Workbench (Agentic UI)"* and Chrome *"STU-2078 …"* — structured, per-window, attributable, and free. This is arbtt's `any window`, which the survey found nobody else implements, and it is the direct fix for a container title. The helper already emits `pid` too (`window-helper.m:86-102`).

   Unlike OCR, these do not bleed: each title is bound to a named window, so co-presence can be *weighted* (frontmost > large > background) rather than summed into soup. They ride `sense_captures`, so retention is already correct — but they are raw at write time like every Sense title, so they pass `redact()` at the Desk boundary both on read (prompt assembly) and before any persistence into `evidence_json`.

2. **Read `kAXURLAttribute`.** `accessibility-helper.m` walks Role, Title, Value, Description, Children — never URL. `linear.app/a8c/issue/STU-2079` is the strongest project token available on the machine and it is one attribute away. Fold URL into the signature and into matcher fields with rank above `title` — **origin + path only, per hard line 5**; query and fragment die at the helper boundary. One integration reality to probe first: Chromium-family apps (Chrome, Electron, Edge) expose a full AX tree only when they believe an assistive tech is present — reading `AXURL` may require setting `AXEnhancedUserInterface`/`AXManualAccessibility` on the app element, which has observable side effects on some apps. Safari exposes it natively. Budget a probe before counting on it; Safari-plus-title may be the honest v1.

3. **Make accessibility primary, OCR the fallback.** screenpipe's Feb 2026 migration reported *"100x less resource usage, 100% data accuracy."* Today's ratio is **24,772 OCR to 191 accessibility captures** — and the code review found exactly why, in three parts (`text-router.ts:26-56`): AX requires a `pid`, and the `pid` column landed late, so all history routed to OCR; the per-app quality cache is a **sticky one-way downgrade** — one AX return under 20 chars pins the app to OCR *forever*, and nothing ever sets the preference back; and a global `textExtractionPreference: 'ocr'` disables AX everywhere. "Make AX primary" therefore means: prefer AX whenever a pid exists, and give the downgrade a way back (re-probe after N days or on app version change) — not merely flipping a default.

4. **Drop the OCR excerpt from the inference prompt.** `excerptFor()` sends 160 chars of whole-screen OCR per segment. Two independent lines of evidence say remove it:
   - **It doesn't work.** Lift analysis above: no token above 1.30× on the signatures covering 40% of the day.
   - **It is where the privacy exposure concentrates.** Titles and paths are structurally lower-risk than free screen text — bounded, per-window, and format-stable. Redaction benchmarks put best-case secret recall at 88% *on curated source files*; screen OCR has no file extension, no syntax, and substitution noise that breaks tokens across lines. Assume materially worse.

   Privacy and accuracy point the same way here, which is rare. Replace the excerpt with the co-visible titles from (1). A third line of evidence, from review: the excerpt is clipped to 160 chars *before* redaction (`inference.ts:136-138`), which can slice a secret across the boundary so the pattern no longer matches — removing the excerpt removes the bug; if an excerpt ever returns, redact-then-slice.

**Expected effect.** All of these attack the 68% of the day with a container title, using structured evidence rather than the ambient screen. Nothing here needs a model.

### Phase 1.5 — Inference hygiene (half a day)

The model's write authority is unbounded in three cheap-to-fix ways, and each one is measured in today's data:

1. **Thread names are unvalidated.** `parseResponse` trims a `NEW:` name and slices to 80 chars (`inference.ts:248-250`); `createThread` accepts anything (`store.ts:151-164`). `tooBroadReason`/`isGenericWord` are applied to matcher *patterns* only, never to thread *names* — which is how `one-off` was born. Bar container names (the same observation-derived list as hard line 2) and junk-drawer names (`one-off`, `misc`, `other`) from `NEW:`.
2. **No cap on matchers per thread.** `writeInferredMatcher` inserts unconditionally after the authority checks (`matchers.ts:270-299`) — `one-off` accumulated 57. Cap inferred matchers per thread per day, and let the never-fired count trigger pruning of stale inferred matchers — which finally makes `hits` an input to a decision instead of a display column.
3. **The model cannot say "this is not work."** Every resolution must land on a thread, so leisure mints threads: *Dave Matthews Band setlist*, *Rick and Morty YouTube TV*, the film review. Allow a `NONE` verdict — segment resolves with `attributed_thread_id = NULL`, state `resolved` — so it stops re-querying, stops minting threads, and never surfaces a block. This is not grading: Desk describes work, and declining to file leisure *as work* is a description. Nothing is shown, counted, or compared.

Plus the one-time cleanup: archive the junk threads (three currently have zero attributed segments), folded into Phase 1's signature-break migration.

### Phase 2 — Derived attribution (2–3 days)

1. Add `desk_labels` (segment, thread, source `matcher|model|user`, **provenance** — the matcher id or inference batch id that produced it — confidence, rules_version, created_at).
2. Add `rules_version` to `desk_runtime`; bump on any matcher create/edit/delete/confirm and on thread merge/rename/archive.
3. Demote `attributed_thread_id` to a cache with `derived_at` + `derived_rules_version`.
4. Re-derivation sweep on the existing worker queue, **bounded**: newest-first, N segments per tick — the notch reads the cache, so staleness is invisible and there is no reason to re-derive 90 days synchronously. Stale cache rows re-resolve against current rules; a user label always wins and is never re-derived; a model label is superseded by a matcher only if the matcher is confirmed. Both `apply()` and the sweep honor hard line 6 — check for a newer user label before every write.
5. **Correction becomes retroactive.** Reassigning a block re-derives every segment the changed rule touches — the ManicTime *"autotags work on any day in the past"* property. This is what makes a wrong guess cheap.
6. **Lifecycle from birth, not as an afterthought.** Labels are swept with their segments at `textRetentionDays`; a thread merge re-points label thread references inside the merge transaction (the merge already re-points seven tables — labels become the eighth); growth is bounded by segment count × sources.

Provenance in (1) is not decoration — it pays twice. It is what lets Phase 3's rejection find and drop **all** matchers an inference batch wrote for a pairing: today model-resolved segments deliberately store `matcher_id = NULL` (`inference.ts:419-423`), so `dropInferredMatchersForThread`'s segment subquery structurally cannot see the broad `title`/`path` matcher that did the damage (`matchers.ts:415-427`) — rejection kills the exact-resource matcher and the broad one survives to claim the next resource. And it fixes the stats at the root: `source` on the label distinguishes user/matcher/model, where today a user reassignment writes `matcher_id = NULL` and gets counted as a *model* resolution, feeding its hours-later `attributed_at` into median unknown-latency (`stats.ts:40-64`, `service.ts:230-236`).

One more consumer of labels while in here: `reassignBlock` teaches only `segments[0]`'s resource (`service.ts:223-255`) — a multi-resource block (terminal + Figma + browser, one thread) leaves every other resource unknown, to be re-bought from the model next time. With labels, a reassignment can write a user label per distinct signature in the block at zero extra model cost.

### Phase 3 — Close the learning loop (1–2 days)

1. **Populate, don't add.** `candidate_resource_signature` and `candidate_matcher_id` have existed on `desk_runtime` since the schema was born — write both in `evaluateSwitch`, stamp both onto the question at creation. That un-deads the entire rejection path — suppressions, matcher drops, attribution clearing, the three-strike rule. Also fix the NULL-signature short-circuit to still run the block fall-back (`questions.ts:239-244`), so rejecting any legacy or edge-case question at least restores the block instead of leaving it on the rejected thread.
2. **Accept confirms a rule — behind the container bar.** Blindly promoting the matcher behind the proposal would cement the exact failure this plan exists to fix: the Bond↔Studio alternation questions are backed by *container* signatures, and confirming one turns `title contains "bond"` permanent with user authority. Accept confirms only a **concrete pattern** — a path, a URL, a distinctive title prefix — that clears hard line 2's container check; a bare container signature is never confirmable through an Ask, only through the explicit rules editor. The question row carries the concrete pattern it would confirm (from `candidate_matcher_id`), so accept knows what it is promoting and the surface can show it.
3. **Rejection reaches everything the model wrote.** Via Phase 2 provenance, rejecting a pairing drops the exact-resource matcher **and** every matcher from the same inference batch pointing at that thread — today the broad `title`/`path` matcher structurally survives rejection (see Phase 2).
4. **Break the alternation cycle.** Do not re-ask a question whose (signature, thread) pair was auto-accepted or rejected within the day — and **persist** the dedupe key so a daemon restart can't forget it. Eleven identical auto-accepts is the system asking the same question twelve times and learning nothing. Note what dedupe does *not* fix: the asking stops, but the ~23-minute Bond↔Studio block churn keeps committing. The Phase 0 rolling-window fix removes the stale-leader half; add switch **hysteresis** (a stronger majority to switch away than to stay) as the one small knob here. Whether rapidly alternating blocks should *merge* is Phase 4's question — don't design it yet.
5. **Ask about the informative case, not the loudest one.** The Bond↔Studio alternation is the *least* informative question in the day — both threads are real and both are active. Prefer questions where a single answer resolves the most unattributed presence time.
6. **Questions expire even when Desk is off.** `expireQuestions` runs only inside `segmentTick`, which returns early when not running (`worker.ts:76-77`) — a pending Ask survives Desk being turned off and auto-accepts a stale switch on the next start. Expire on startup and on `setRunning(false)`.
7. **Timely Asks need the immediate path wired — or deleted.** An unknown resource contributes nothing to any thread until the 15-minute sweep classifies it (`rollingWindow` sums only *attributed* presence), so the three-minute Ask contract is structurally unmeetable for newly-encountered work. Wire `runBatch('immediate')` behind the now-real ceiling from Phase 0, triggered when an unknown candidate crosses the noise floor; if instead the sweep interval comes down far enough to cover it, delete the immediate machinery outright. A path with zero callers and a dead budget is worse than either choice.

### Phase 4 — Reconsider the block (needs data from Phases 1–3)

Deliberately not specified yet. 58% of blocks are labelled with a minority thread, boundaries are set by question timers rather than by work, and 34% of presence is in no block at all — but I do not yet know how much of that is the block model versus the attribution feeding it. **Re-measure after Phase 2 before designing anything here.**

The open question to answer with that data: should a block carry *one* thread at all, or a weighted set with a dominant label? The re-entry notes suggest work is genuinely interleaved and the single-label model is fighting reality.

---

## What to measure

Current instrumentation cannot answer the question the go/no-go turns on. `bond desk stats` reports calls, tokens, and cache-hit rate — but **cache-hit rate is the wrong metric**: today's 78% hit rate is 78% of the day that never got a second look. A higher number is a *worse* system.

Add:

1. **Attribution agreement** — how often does the block's thread match the plurality of its own segments? (Today: 52%.) This is the honest accuracy proxy and it needs no ground truth.
2. **Note/attribution disagreement** — how often does the generated re-entry note name a different project than the block's thread? Mechanize it in the note call itself: the generator already knows the block's thread — have it also name which known thread the note text describes (one extra output line, same call) and record the agree/disagree bit. Free at generation time, deterministic to read later.
3. **Correction rate and half-life** — how many blocks does the user reassign, and how long does a wrong attribution survive?
4. **Panel opens and note reads.** The way these products actually die, from RescueTime's own Launch HN: *"Stopped a while ago when I realized I'd stopped looking at it and had stopped feeling like I needed it."* No current ship criterion measures whether the re-entry note is ever read. This needs one tiny event RPC from the desk window (glance shown, panel opened, note expanded) into `desk_metrics` — nothing exists today to carry it.
5. **Ask outcomes.** The Ask is the only thing Desk says out loud, it is budget-gated — and it is wholly uninstrumented: `stats` has no asked/accepted/rejected/auto-accepted counts at all. The annoyance-budget go/no-go currently has no data. (Today's tally had to be pulled by SQL: 3 accepted, 1 rejected, 12 auto-accepted.)

And **fix the counters before reading them**, because three of them currently lie:

- User reassignments are counted as *model* resolutions and their hours-later `attributed_at` pollutes median unknown-latency (`stats.ts:40-64`; fixed at the root by Phase 2's label source).
- `status` and `stats` both report "unresolved segments" — on different scopes (all-time vs windowed) under one label. Permanently-failed segments never drain from either (`retry_at = null` is terminal); report `failed` separately so "still catching up" stops covering for "gave up."
- `desk_metrics` is the one Desk table with **no retention path** — `catchUp` alone can add 200 rows per launch, forever. Add it to the sweep.

The back-fill abandonment that motivated this section is now Phase 0.7 — root cause was the 24-hour horizon, and the ledger makes any future giving-up visible. Any go/no-go today is still a read on **one 17-hour window** that includes its own cold-start burst.

---

## What is explicitly not changing

- **The product rules in `plans/desk.md` all stand**, and rule 1 now has an effect size behind it. The meta-analysis on electronic performance monitoring (Ravid et al. 2023, *Personnel Psychology*, **K = 94, N = 23,461**) finds **person-targeted** monitoring correlates with perceived privacy invasion at ρ̄ = **.46**, **task-targeted** at ρ̄ = **.19** — and states that *"no observed relationship in our meta-analysis was stronger."* "Desk describes. It never grades" is what keeps Desk on the .19 side; a productivity score or app-usage chart moves it to .46. Same paper: **periodic beats continuous** (synchronous collection → attitudes ρ̄ = −.29, asynchronous → .00), which validates Sense's interval sampling and the 15-minute sweep.

  The `~` in `~1h 20m` is load-bearing too: a paying Timing user quit with *"if all or most of my time spent digitally [is] not going to be accurately logged then I may as well not use Timing at all."* A system that never claims completeness cannot have its completeness disproved.

- **Stop relying on purpose framing.** Same meta-analysis: purpose framing was **not a significant moderator of anything** — not attitudes, not stress, not performance, because *"individuals often come to their own conclusions about the purpose of monitoring even when a purpose is communicated to them."* Telling the user "this is for you, not anyone else" buys nothing measurable. What does have numbers attached is **control** (fairness .27, autonomy .22) and **transparency** (.21–.37) — in Desk terms: the pause, the exclusion list, the rules editor, and showing the evidence behind an attribution. That is an argument for surfacing *why* a block was labelled, which the derived-attribution model in Phase 2 makes possible for the first time.
- **Silence still teaches nothing.** Product rule 4 survives contact with the data.
- **Observe-then-ask stays.** Rules-first is rejected by users in the exact terms Desk was designed around: *"It's basically impossible for me to set up rules in advance as the whole point is to track my activity and identify habits as I see them… anything that isn't completely frictionless is basically unusable for me."* The shape is right; the loop just never closed.
- **Redaction is not the security boundary.** Every vendor in that space disclaims completeness in writing (Presidio: *"no guarantee that Presidio will find all sensitive information"*), measured recall on high-sensitivity PII is 0.07 for rule-based detection, and multi-line secrets — the default condition for OCR'd screen text — are a documented blind spot. Keep `redact()`, but justify transmission by *restricting which surfaces are eligible*, not by claiming the scrubber works. App and window exclusion is the only deterministic control; content filtering is convenience.

- **Don't chase local inference, and don't chase encryption at rest.** Both look like the obvious privacy answer and neither pays.
  - **Apple's on-device Foundation Models are unavailable to Desk by design.** Per an Apple engineer on [Developer Forums 789788](https://developer.apple.com/forums/thread/789788), *"Rate limiting applies when your device is on battery AND when your process is running in the background."* Desk's worker is exactly that — a `setInterval` sweep in a long-lived background daemon.
  - **A bundled local model costs ~75× the memory.** llama.cpp/MLX at Q4 runs ~0.55–0.65 GB per billion params, so a 3B model is ~2 GB resident in a background daemon, against **27 MB** for Apple's framework whose weights are system-shared. Untenable on 8–16 GB machines.
  - **Encryption at rest defends nothing here.** Microsoft Recall was re-broken in April 2026 by injecting into `AIXHost.exe` — the process that receives plaintext *after* decryption — with no admin rights. MSRC closed it as "Not a Vulnerability." The author's summary is the lesson: *"The vault is solid. The delivery truck is not."* The daemon must read the database, so a key bound to the machine buys protection only against offline disk theft.

  The honest privacy improvement, if wanted later, is a split: closed-set assignment against known threads resolved locally, escalating only genuinely novel resources. Batching to a remote `'fast'` tier every 15 minutes is defensible on these grounds — not merely convenient.

---

## Sequencing

| Phase | Effort | Unblocks |
|---|---|---|
| 0 — integrity, behavior, honesty bugs | ~1 day | Trustworthy measurement; the user-wins invariant |
| 1 — recover existing signals + the one-time signature break | 1–2 days | The 68% container problem, without a model |
| 1.5 — inference hygiene | ~half a day | Junk stops accumulating before Phase 2 measures |
| 2 — derived attribution | 2–3 days | Correction retroactive; provenance for rejection and stats |
| 3 — close the learning loop | 1–2 days | The system can finally learn from you |
| 4 — reconsider the block | TBD | Needs Phase 2 data first |

**Start with Phase 0 now — it stopped being optional.** The first draft called it small; the code review filled it with behavior fixes (the rolling window, user-writes-win, the sweep budget) that Phase 1's own evaluation depends on. A day of Phase 0 ends with numbers that can be trusted and a system that can't overwrite its user. Then Phase 1, whose signature break must land **before** anyone confirms a matcher or records a suppression — it is free exactly once. Phase 1 remains the only work that changes what Desk *knows* rather than what it does with what it knows: if co-visible titles and AX URLs resolve the container problem on their own, Phases 2 and 3 get simpler — and if they don't, that is worth learning before building a derivation engine.

---

## Known research gaps

Stated so nobody mistakes an unexamined area for a settled one.

1. **Online classification with human feedback was never systematically surveyed.** This is the literature directly under Phase 2 and 3 — confidence-gated caching, re-validation of cached decisions, active learning, decision decay. The research pass covering it stalled and produced no output. The prior-art answer from the tracker survey is unambiguous (*nobody does any of it*), so Phase 2's design is derived from first principles plus arbtt's re-derivation model, not from a body of practice. Worth a dedicated pass before Phase 2 is built.
2. **Noisy-OCR entity extraction** was likewise not surveyed. Phase 1 step 4 removes the dependency on OCR text entirely, so this is only relevant if that decision is reversed.
3. **Two of the numbers here rest on a single day.** 2026-07-19 is 100% unclassified and 2026-07-20 has 2 blocks. Re-measure the attribution-agreement baseline (52%) over a week before treating any of it as a trend.
4. **Not evaluated:** whether the co-visible window set is *stable* enough to attribute on. Figma showing "Studio Workbench" while Bond is frontmost is strong evidence; Slack sitting open all day is not. Phase 1 should weight by layer/frontmost/area and measure the discriminative lift the same way this document measured OCR's — if co-visible titles don't clear a lift threshold, they are noise too, and that must be checked rather than assumed.
5. **What deleted the orphaned segments is unexplained.** The 12,454 orphan links point at segments that no longer exist, spanning 07-17 → 07-21 01:32, while surviving segments start 07-20 00:00 — and the only `DELETE FROM desk_segments` in the codebase is retention's, behind a 90-day cutoff. Almost certainly a dev-era table reset, but check `daemon.log` once before closing it: if something in production deletes segments, the FK fix makes the links cascade correctly while the cause stays at large.

---

## Appendix — adjacent findings from the same review

Out of this plan's scope (attribution), recorded here so they aren't lost. None block the phases above.

- **Flat displays weaken the menu-bar invariant.** `clampHotRects` is exact on a notch (the safe band is the notch's own dead pixels) but on a non-notched display the 420 pt `FLAT_SAFE_WIDTH` band sits over *real* menu-bar content (`desk-window.ts:107, 117-157`); safety there rests on the renderer painting opaque inside the band, and no test proves it. Residual risk to document, or shrink the flat band to the Rest lozenge's actual width.
- **The `desk-window.ts` host loop has no tests.** Only pure `clampHotRects` is covered; the cursor poll, display-follow dwell, suppression handling, `teardown` (which also doesn't own `handleDisplayChange`'s settle timer, `:297-299`), and the briefly-stale hot rects across a notch↔flat display move are all untested — the code most likely to leak a timer or misbehave on multi-display.
- **`bond desk matchers` prints thread UUIDs, not names, and has no disable/delete verbs** (`desk-helpers.ts:139`) despite the RPCs existing — "the rules editor, in text" currently isn't one. Phase 3's confirm/reject work is the natural time to finish it.
- **Retention can orphan a suppression's thread.** The inferred-thread sweep guard checks blocks, matchers, todo links, and segments — not `desk_suppressions` (`retention.ts:109-118`). A rejected-and-suppressed thread with no other references gets deleted; now that FKs are enforced the suppression row cascades away with it, which *weakens negative evidence* — the one thing merge logic was explicitly built never to do. Add suppressions to the guard.
- **Wiring that implies behavior that doesn't exist:** `markAsserted` is exported and never called (`questions.ts:100`); `candidate_matcher_id` / `candidate_presence_seconds` are written to `desk_runtime` but never read for any decision (`store.ts:605-616`). Phase 3 items 1–2 finally give the candidate columns their job; delete `markAsserted` or use it.
