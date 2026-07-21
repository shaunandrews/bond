# Desk — What's On Your Desk

> **Revision 5** — Changes from rev 4, all five verified against the code first: fullscreen suppression had **no data source** (`DetectedWindow` carries no bounds or layer, and window polling stops with Sense) — `window-helper.m` now emits layer/frame and Desk runs its own poll from main, budgeted into Phase 3; the eligibility gate was wrong on two axes and is now `image_path IS NOT NULL OR image_purged_at IS NOT NULL` plus a 10-second age floor; a live Sense wedge (one failed screenshot blocks all captures until restart) is added to Phase 1; a `bond desk` CLI with `stats` is added to Phase 2 because the go/no-go had nothing to read; window titles and paths — never redacted, raw since trigger time — must now pass `redact()` before transmission and persistence. Smaller: suppression-merge collision resolution, `TODAY` prefix reconciliation, `presence_seconds` derivation from the user's configured capture interval rather than a hardcoded 15 s.
>
> **Revision 4** — Changes from rev 3: matcher mutations now follow an explicit authority matrix; rejecting a suggestion removes the inferred attribution that produced it; segments retain an attribution snapshot and candidate state survives restart; retention is defined per artifact, including matcher examples and inferred threads; edited notes graduate to a user-authored thread note before their source block expires; Today gains explicit link/unlink/carry RPCs; the legacy-project deletion is documented as an intentional destructive retirement.
>
> Design + implementation plan. Desk is a new surface built on the existing Sense capture pipeline: a notch-anchored floating panel that tracks the work threads currently in flight, keeps a re-entry note for each one, and holds today's todos. Electron mechanics in this plan were verified by live probe on a 16" M4 Max / macOS 26.5 / Electron 41.10.2 — measured values are marked **[measured]**.

## Why

Sense today is a timeline you scrub with the mouse. It is an impressive trick and a weak product: it shows you that Bond was watching, but it never uses what it saw.

Meanwhile the actual working day looks like this — Bond's mobile web composer, *and* a Studio sync dialog, *and* a blog draft, *and* an intermittent internet problem, *and* three more. Every switch drops the state held in your head for the thing you just left.

**Sense is the eye. Desk is what's on your desk** — the threads currently in flight, what each one was mid-way through, and what you said you'd get to today.

### This is not a time tracker

Every product in this category — Rize, Timely, Memtime, Timing, RescueTime — descends from billing, and answers *"how much time did you spend."* That question traps them: a wrong entry costs money, so every entry must be reviewed, and the review costs more than the automation saved. Memtime published [an entire post refusing to build AI tracking](https://www.memtime.com/blog/ai-time-tracking) on exactly this basis — they cite competitors' ~80% accuracy and conclude "you must investigate every AI time entry." RescueTime warns its AI timesheets take about a week of manual correction before they're trustworthy.

Desk answers a different question: **where was I?**

That reframe is what makes it shippable. Nothing has to be right. A wrong guess costs one click, not an invoice — so Desk can ship at an accuracy that would kill a timesheet product. But the reframe only holds if the surface never *demands* correction. Wrong-and-ignorable is fine. Wrong-and-nagging is the failure mode that kills the feature.

---

## Product rules

These are hard lines, not v1 scope cuts.

1. **Desk describes. It never grades.** No productivity score, no streaks, no daily target, no "you spent 2h 40m in Slack," no comparison to yesterday. Every feature that would rank the day is permanently out of scope. The sharpest finding in the research came from a year-long screen-tracking dogfood thread: *"most people are actually not that 'ready' to get judged objectively about their own behavior, most people shield themselves from it."*
2. **Time is always approximate.** `~1h 20m`, never `1h 23m`. Sense samples every 15 s and sees nothing during a call, a whiteboard, or time away from the desk. The tilde is the panel telling you not to audit it — the cheapest possible defense against the review-burden trap.
3. **Correction teaches at the narrowest safe scope.** A reassignment always fixes the block immediately. It creates a durable rule only when Desk can name the concrete resource pattern that rule would match; otherwise it stores a one-resource attribution and asks no further question.
4. **Silence is local consent.** An ignored question may resolve the current block, but it never creates a reusable rule. The user is never blocked and never has to dismiss anything.
5. **Never steal focus.** Desk is a non-activating panel. Clicking it does not bring Bond to the front.
6. **Never break the menu bar.** Desk sits above the menu bar and must be click-through everywhere it isn't actively being used.

---

## The surface

### Four states

| State | Geometry | Trigger |
|---|---|---|
| **Off** | Nothing | Desk not running |
| **Rest** | A hairline flanking the notch | Always, while running |
| **Glance** | Lozenge drops — thread + coarse time | Hover (400 ms delay) |
| **Open** | Full panel drops from the notch | Click |

At rest, the resting state costs **zero pixels** — it occupies the notch's own width, which is already dead black. This is the strongest available version of ambient presence: there is nothing to get out of the way.

`running` is explicit persisted Desk state, independent of Sense's capture setting. `open_desk` turns it on; closing from Desk's menu turns it off. On app launch, a running Desk recreates its Rest window. If Sense is disabled or suspended, Desk may show historical threads and Today but uses a subdued hairline, accumulates no presence, generates no inference, and produces no Peek or Ask. While Sense is idle or paused, the current block remains open but its presence clock stops. Resuming Sense continues the segment unless the 60-minute session gap has elapsed.

Three channels fit in that hairline, which is enough:

- **Presence** — is Desk running
- **Thread identity** — colour. `appHue()` / `appColor()` in `src/renderer/composables/useSense.ts` already derive deterministic HSL from a bundle id; reuse the same function keyed on Desk thread id.
- **Uncertainty** — dimmed or dashed while Bond is still deciding

Hover uses a **400 ms** delay, matching Bond's existing `v-tooltip` directive. Top-of-screen is where the cursor goes to reach the menu bar, traffic lights, and window drags — without a delay it becomes a minefield.

### What Desk is allowed to do on its own

Desk may move without being asked; it is Bond's ambient voice. The budget therefore moves from the *interaction* to the *trigger*. Three levels of assertion, and nothing above them, mapping to Mankoff's ambient-display taxonomy (CHI 2003): every update is classified **change-blind**, **make-aware**, or **interrupt**, and the transition's abruptness must match.

| Level | Motion | Category | Used for |
|---|---|---|---|
| **Tick** | None — hairline colour/opacity only | change-blind | Confidence building, ambient presence |
| **Peek** | Drops ~8 pt, holds 3 s, auto-retracts | make-aware | "Noted." A block committed. No action wanted. |
| **Ask** | Drops to a one-line lozenge, holds ~20 s, retracts to a pending hairline | make-aware | "Moved to Studio?" — yes / no |

**Nothing is ever an interrupt.** No modal, no sound, no bounce, no Notification Center entry, no badge. Desk has exactly one channel.

Hard limits:

- **Nothing in the first 3 minutes of a switch.** Below that you are looking something up, not switching tasks — the average dwell on any single window is ~2 minutes.
- **One Peek-or-Ask per 10 minutes, maximum.** Persist the last assertion time so a restart cannot reset the budget. The research constant `r = 10` motivated the silence window, but Desk defines it in wall-clock time because Sense observations arrive every 15 seconds.
- **Three strikes.** Reject the same resource-to-thread suggestion three times and Bond permanently suppresses that pairing. A rejection never becomes a positive attribution rule.
- **Silence is local consent.** An ignored Ask retracts and commits this block after a few more minutes. Silence never creates a reusable rule.
- **Motion budget: `transform` and `opacity` only.** Compositor-only. No `width`/`height`/`clip-path` animation, no spring, no bounce.
- **Redraw at 1 fps** when only the clock is changing. Rize's floating widget originally redrew at 60 fps and burned ~25% CPU to display `mm:ss`; dropping to 1 fps took it to ~1%. Ambient chrome must never cost more than the work it reports on.
- **`prefers-reduced-motion`** collapses Peek and Ask to instant state changes.

### Fullscreen

When the frontmost app is fullscreen, Desk hides. A false positive merely hides Desk; that is safer than interrupting fullscreen focus. Private CGS APIs are out of scope.

**Nothing in Bond can currently answer this question, so the mechanism has to be built.** `DetectedWindow` (`src/shared/sense.ts:70`) carries only `name`, `bundleId`, `title`, `active`, `pid` — no bounds, no window layer — so `bond-window-helper` cannot report whether the frontmost layer-0 window covers the display. And window polling is *Sense-gated*: it stops when Sense is disabled, while Desk is explicitly required to keep running and keep hiding on fullscreen in that state.

Two small pieces close it, and neither is new native work in the hard sense:

1. **Emit what the helper already computes.** `window-helper.m:46-55` reads `kCGWindowLayer` and `kCGWindowBounds` today — it just uses them internally for an area check and throws them away. Add `layer` and `frame` to the emitted JSON and to `DetectedWindow`. Existing consumers ignore new fields.
2. **Desk polls it itself, from main, at 1–2 Hz.** Not from the daemon and not through the Sense controller — main owns the window, needs the answer when Sense is off, and is where `win.hide()` happens anyway. This is an independent low-rate spawn of the same helper binary, resolved through `resolveHelperPath()`.

Budget this into Phase 3; it is roughly an hour on top of the window work.

### The panel contents

Two lists, kept structurally separate:

**In flight** — work threads Bond *observed* you doing. Each row: colour mark, thread name, **the re-entry note**, and coarse time. The note is the point of the whole feature; the time is secondary decoration.

**Today** — todos *you* said you'd get to. Checkboxes.

These must never merge into one list. One is inferred and one is intentional, and blurring that makes the inferred half feel like an accusation. They meet in exactly one place: `desk_todo_links` can associate a todo with a work thread, and when Bond notices that thread start it offers *"Looks like you're on the ISP thing — mark it started?"*

Absent by design: percentages, app-usage bar charts, focus scores, yesterday comparisons. Apple's HIG on HUD panels is one line and worth obeying — *"Keep HUDs small. HUDs are designed to be unobtrusively useful."*

---

## The five moments

Sequential — one pass through a working day. Each has a specific failure mode the design spends effort avoiding.

### 1. Starting — and it's already caught up

You type *"let's get to work."* Bond opens Desk. **It is not empty.** Sense has been running all morning, so Desk back-fills the last few hours the instant it appears: *"You've been on Bond mobile web about 40 minutes, and you touched Studio briefly at 9:20."*

This is the moment that sells the feature, and it is free — the data is already in `sense_captures`. A tracker that starts at zero when you press start is a stopwatch. One that already knows is something else.

**Failure mode:** an empty panel on first open. If back-fill isn't ready, don't open the window — have Bond say "give me a minute" and open it populated.

### 2. Switching — silence is local consent

You alt-tab to Studio. **Nothing happens for three minutes.** Once the switch has held, an **Ask** drops: *"Moved to Studio?"* Ignore it and it commits *this block* to Studio and teaches nothing. Click *No* and it stays put and stops asking about Studio for the rest of the day.

The 2007 Oregon State work on desktop task detection landed on the same rule for the same reason. Their stated requirement: the detector *"must be highly precise (i.e., have very low false alarm rate), and it must be timely… so as to avoid interrupting the user once he or she is fully engaged in the new task."* They popped a balloon asking permission. They never switched silently.

**Failure mode:** flip-flopping. Their naive classifier — an SVM over window titles, judging each observation independently — *"achieves fairly high accuracy [but] is unusable in practice because it produces far too many task-switch false alarms."* The fix is temporal aggregation; see the pipeline.

### 3. Correcting — the correction *is* the teaching

Any block, one click, reassign. The block updates optimistically. If the block has a safe matcher candidate — for example an exact repository path or a distinctive title prefix — the same gesture confirms it as a rule. Generic apps such as Chrome, Terminal, Finder, Slack, and VS Code never become bundle-wide rules merely because a block was corrected.

Bond says what it learned **once, visibly**: *"Got it — windows titled ‘Studio — Sync Dialog’ will go to Sync dialog."* If it only fixed the observed resource, it says *"Moved this block to Sync dialog."* Then it stops talking about rules. A rules editor exists in Settings for disabling or deleting a bad matcher.

**Failure mode:** slow feedback. A Rize reviewer: *"it takes a little while to update when you change activity categories, so it's hard to see things reflected instantly."* Reassignment must be optimistic and instant in the panel; the rule write happens behind it.

### 4. Parking — the feature nobody else has

When you leave a work thread, Bond writes **one line about where you were**, from the Sense text it already has: *"Left at `SyncDialog.tsx` — conflict-state copy unwritten."*

An ICSE 2026 study ([TaCoS](https://hasel.dev/wp-content/uploads/2026/01/TACOS-pre-print.pdf)) had 32 professional developers resume work after gaps of one to seven days. AI-generated context summaries produced the **shortest resumption lag and edit lag** of any condition and were rated most helpful — but lost on task success, because they lacked the forward-looking "what was I about to do" information that hand-written notes carried. They also found only the **last 30 minutes** of activity was worth retaining as relevant context.

So: the note is written **at departure, in the present tense of the work**, from a short lookback — not reconstructed later from a day summary. That constraint is why this belongs in a live panel rather than an end-of-day report.

**Failure mode:** notes that summarize instead of orient. *"Worked on Studio for 40 minutes"* is useless. *"Conflict-state copy unwritten"* is the product.

### 5. Returning — pick the thread back up

Click a parked thread and the note expands with the last few things Sense saw: files, a branch name, a couple of tab titles. Optionally Bond offers to *pull it back up* — reopen the files, check out the branch, restore the tabs.

This gets used more than the start path. Interrupted work is resumed the same day **77.2%** of the time, but only after an average gap of **25 min 26 s** and **2.26** intervening activities (Mark et al., CHI 2005). The multi-thread pattern is the documented norm, not an edge case.

**Failure mode:** doing the restore without asking. Reopening files and switching branches is a write; it goes through Bond's normal approval, always.

---

## Architecture

### The seam

```
Sense                          Desk
─────                          ────
captures, text, retention  →   threads, blocks, segments, matchers, notes
sense_captures                 desk_threads
sense_sessions                 desk_blocks
sense_app_text_quality         desk_segments / desk_capture_links
                               desk_matchers / desk_questions / desk_runtime
```

**Desk reads Sense. Sense never knows Desk exists.** Either side can be rewritten independently. Desk introduces no new capture mechanism and no new capture permission. Its only additional native reads are display geometry and the fullscreen-window heuristic — the latter needs `window-helper.m` extended to emit window layer and frame, which is an additive change to a binary Sense already ships.

### Desk's unit is a thread

The retired `projects` table and its four dead `project_id` foreign keys were **deleted** ahead of this plan (`migrateDropRetiredTables` in `db.ts`), so there is nothing to migrate from, reference, or overload. `memory_items.project_id` survives untouched — it is a plain scope string with no foreign key, and it is not a Desk concept. This retirement is intentionally destructive: old project rows and their dead relationships were unreachable from the current product and are not exported or imported into Desk. The migration fixture with populated relationships documents and tests that decision while verifying the surviving parent rows are preserved.

- A **thread** is a lightweight name for a coherent piece of work: *Bond mobile composer*, *Studio sync dialog*, *ISP problem*.
- Threads may be inferred, user-named, merged, or archived. They do not imply a repository, billing project, collection, chat session, or durable organizational hierarchy.
- Inference may propose a provisional thread. A thread becomes established after a user names/confirms it or after it appears on two separate blocks with high confidence.
- Near-duplicate proposals are matched by normalized name plus recent resource evidence. Ambiguous proposals remain separate candidates for the user to merge; the model never silently merges established threads.
- Archive is manual in v1. Desk may hide a thread from **In flight** after seven untouched days, but it does not set `archived_at` without the user.

### Data model

All tables are added by `migrateCreateDeskTables(db)` at the end of the migration chain in `db.ts`. Migrations use idempotent `CREATE TABLE IF NOT EXISTS` and pragma-guarded additions; there is no `APP_SCHEMA_VERSION` bump because that bump is the destructive cutover.

```sql
CREATE TABLE IF NOT EXISTS desk_threads (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  color_seed      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'provisional', -- provisional|established|archived
  source          TEXT NOT NULL,                       -- inferred|user
  user_note       TEXT,
  user_note_updated_at TEXT,
  last_seen_at    TEXT,
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_threads_status_seen
  ON desk_threads(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS desk_blocks (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT REFERENCES desk_threads(id) ON DELETE SET NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  presence_seconds  INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'candidate', -- candidate|committed|dismissed
  summary           TEXT,
  reentry_note      TEXT,
  note_status       TEXT NOT NULL DEFAULT 'none',      -- none|pending|ready|failed|edited
  confidence        REAL NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'inferred', -- inferred|confirmed|manual
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_blocks_started ON desk_blocks(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_desk_blocks_thread ON desk_blocks(thread_id, started_at DESC);

CREATE TABLE IF NOT EXISTS desk_segments (
  id                 TEXT PRIMARY KEY,
  block_id           TEXT REFERENCES desk_blocks(id) ON DELETE CASCADE,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  presence_seconds   INTEGER NOT NULL DEFAULT 0,
  resource_signature TEXT NOT NULL,
  evidence_json      TEXT NOT NULL DEFAULT '{}', -- bounded bundle/title/path snapshot, never frame data
  attribution_state  TEXT NOT NULL DEFAULT 'unresolved', -- unresolved|queued|resolved|failed
  attributed_thread_id TEXT REFERENCES desk_threads(id) ON DELETE SET NULL,
  matcher_id         TEXT REFERENCES desk_matchers(id) ON DELETE SET NULL,
  attribution_confidence REAL NOT NULL DEFAULT 0,
  attributed_at      TEXT,
  inference_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at           TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_segments_block ON desk_segments(block_id, started_at);
CREATE INDEX IF NOT EXISTS idx_desk_segments_resource ON desk_segments(resource_signature);

CREATE TABLE IF NOT EXISTS desk_capture_links (
  segment_id TEXT NOT NULL REFERENCES desk_segments(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL REFERENCES sense_captures(id) ON DELETE CASCADE,
  PRIMARY KEY (segment_id, capture_id)
);

-- One table, two confidence levels. `confirmed = 0` is an inferred attribution
-- for one exact resource; `confirmed = 1` is a user-approved pattern matcher.
-- Splitting these into two tables bought a join and an ambiguity about which
-- one wins; a single ordered lookup is both smaller and easier to reason about.
CREATE TABLE IF NOT EXISTS desk_matchers (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES desk_threads(id) ON DELETE CASCADE,
  field              TEXT NOT NULL, -- bundle|title|path|resource
  operator           TEXT NOT NULL, -- exact|prefix|contains; no regex in v1
  pattern            TEXT NOT NULL,
  normalized_pattern TEXT NOT NULL,
  confirmed          INTEGER NOT NULL DEFAULT 0, -- 0 = inferred attribution, 1 = user-approved rule
  source             TEXT NOT NULL,              -- inferred|user
  confidence         REAL NOT NULL DEFAULT 0,
  specificity        INTEGER NOT NULL,
  example_json       TEXT NOT NULL DEFAULT '{}',
  enabled            INTEGER NOT NULL DEFAULT 1,
  hits               INTEGER NOT NULL DEFAULT 0,
  last_seen_at       TEXT,
  example_updated_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(field, operator, normalized_pattern)
);
CREATE INDEX IF NOT EXISTS idx_desk_matchers_lookup
  ON desk_matchers(enabled, confirmed DESC, field, specificity DESC);

CREATE TABLE IF NOT EXISTS desk_questions (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL, -- thread_switch|todo_started
  block_id           TEXT REFERENCES desk_blocks(id) ON DELETE CASCADE,
  proposed_thread_id TEXT REFERENCES desk_threads(id) ON DELETE CASCADE,
  item_id            TEXT REFERENCES collection_items(id) ON DELETE CASCADE,
  resource_signature TEXT,
  state              TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|auto_accepted|cancelled
  presented_at       TEXT,
  expires_at         TEXT NOT NULL,
  resolved_at        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_questions_pending ON desk_questions(state, expires_at);

CREATE TABLE IF NOT EXISTS desk_suppressions (
  resource_signature TEXT NOT NULL,
  thread_id          TEXT NOT NULL REFERENCES desk_threads(id) ON DELETE CASCADE,
  rejection_count    INTEGER NOT NULL DEFAULT 0,
  suppress_until     TEXT,
  permanent          INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY(resource_signature, thread_id)
);

CREATE TABLE IF NOT EXISTS desk_runtime (
  singleton              INTEGER PRIMARY KEY CHECK(singleton = 1),
  processed_capture_at   TEXT,
  processed_capture_id   TEXT,
  current_block_id       TEXT REFERENCES desk_blocks(id) ON DELETE SET NULL,
  candidate_thread_id    TEXT REFERENCES desk_threads(id) ON DELETE SET NULL,
  candidate_matcher_id   TEXT REFERENCES desk_matchers(id) ON DELETE SET NULL,
  candidate_resource_signature TEXT,
  candidate_since        TEXT,
  candidate_presence_seconds INTEGER NOT NULL DEFAULT 0,
  last_assertion_at      TEXT,
  running                INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS desk_todo_links (
  item_id   TEXT PRIMARY KEY REFERENCES collection_items(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES desk_threads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
```

`desk_capture_links` keeps the dependency one-way without adding a Desk column to `sense_captures`. Capture retention deletes links; Desk's own sweep uses Desk timestamps and therefore does not depend on links still existing.

**Desk-derived data expires with Sense's text retention.** Extend `runRetentionCleanup` in `sense/storage.ts` with one transaction, using the same cutoff as `purgeOldCaptures`:

1. Before deleting expired blocks, copy the most recently updated `note_status='edited'` note per thread into `desk_threads.user_note` only when it is newer than the existing `user_note_updated_at`; set the thread's `source='user'`. This is the explicit graduation from generated evidence to a user-authored thread note; the thread row renders it after the source block is gone.
2. Delete expired `desk_segments`, then delete blocks with no surviving segments. Their summaries, generated/edited block notes, presence totals, and timestamps disappear with them.
3. Delete unconfirmed matchers whose `last_seen_at` is older than the cutoff. Confirmed patterns remain because the user approved them, but clear `example_json` when `example_updated_at` is older than the cutoff.
4. Delete resolved questions older than the cutoff. Suppressions remain because they encode an explicit user rejection and contain only an opaque resource hash, not the captured title/path.
5. Delete inferred threads that have no surviving block, matcher, todo link, or user note. User-created or user-renamed threads, todos, confirmed patterns, and `user_note` are user-authored and remain.

Run this Desk sweep before or after capture deletion—the queries rely on Desk timestamps, not capture links—and cover both orders in tests. No raw title, path, example, summary, generated note, inferred resource attribution, or inferred orphan thread may outlive `textRetentionDays`.

**Tasks are still a collection, not a bespoke task table.** Desk creates one idempotent collection and stores its id in the setting `desk.today_collection_id`. Its schema is `title`, `status` (`todo|in_progress|done|cancelled`), `priority`, and `day` (local `YYYY-MM-DD`); its `issue_prefix` is `TODAY`. The Today list shows items whose `day` equals the current day in the user's current timezone plus unfinished items explicitly carried forward. Midnight refreshes the query but never silently moves an item to another day. `desk_todo_links` provides the only structural connection to inferred work. Collection creation, schema repair, and setting write happen transactionally and are safe to repeat.

**`issue_prefix` has no uniqueness constraint** (`db.ts:302` is a plain `TEXT NOT NULL DEFAULT ''`), so nothing at the database level stops a second collection claiming `TODAY` — and `listReferences()` would then serve two different items for the same `TODAY-n` key, breaking composer autocomplete and message chips. `ensureToday` must therefore reconcile rather than assume: look up by the stored setting id first, fall back to a prefix scan, and if it finds more than one `TODAY` collection, adopt the one the setting names (or the oldest) and clear the prefix on the others rather than minting a third.

### Thread catalogue

The daemon owns `list/create/rename/merge/archive` operations for Desk threads. Inference receives established and recently provisional threads as its closed label set, plus permission to propose one new provisional thread. It may not mutate or merge existing threads. A merge re-points blocks, segment attribution snapshots, matchers, pending candidates, suppressions, and todo links in one transaction, resolves duplicate matchers by the authority rules below, keeps the newest user note, then removes the losing thread.

**The authority matrix covers matcher conflicts but misses suppressions.** `desk_suppressions` is keyed `(resource_signature, thread_id)`, so merging two threads that both suppressed the same signature collides on re-point. Resolve explicitly: take `max(rejection_count)`, the later `suppress_until`, and `permanent = a OR b`. Suppression is negative evidence, and a merge must never *weaken* it — the wrong resolution silently re-enables a suggestion the user rejected three times. Same shape on `desk_matchers(field, operator, normalized_pattern)`: keep `confirmed = 1` if either side has it, sum `hits`, keep the earlier `created_at`. Both need a test with a pre-seeded collision.

### The attribution pipeline

Desk has a fast deterministic path and a slow inference path. The UI clock never waits for the slow path.

**1. Segment immediately.** Poll Sense capture metadata every 2 seconds, ordered by `(captured_at, id)` and checkpointed by the matching pair in `desk_runtime`. App switches and title/path changes close one `desk_segment` and open another. Presence gaps pause duration accumulation; they do not end a thread until the 60-minute session gap. This loop performs no model call. A resource signature is a hash of canonical bundle id plus normalized document/title/path evidence with volatile badges, counters, and timestamps removed; a path participates only when accessibility text exposes it as structured evidence.

**Eligibility gate — two conditions, both required.**

A capture row is inserted at *trigger* time, but `controller.onCaptureReady` re-checks the blacklist against a post-capture window snapshot and **deletes the row** if it now trips (`sense/controller.ts:339`). Reading rows the moment they appear would let Desk segment a capture that is about to be deleted for being 1Password — `desk_capture_links` would cascade away, but `resource_signature` and `evidence_json` would keep the blacklisted window's title forever.

```sql
WHERE (image_path IS NOT NULL OR image_purged_at IS NOT NULL)
  AND captured_at < datetime('now', '-10 seconds')
```

1. **`image_path IS NOT NULL OR image_purged_at IS NOT NULL`** — the survived-the-recheck predicate. `image_path` alone is wrong: `purgeOldImages` nulls it and stamps `image_purged_at` (`sense/storage.ts:83`), and `enforceStorageCap` purges oldest-first **with no age filter at all** — so on a storage-capped day a capture from minutes ago can lose its image while keeping its text. Gating on `image_path` alone would make those captures permanently invisible to the sweep and to startup back-fill.

2. **A ~10-second age floor**, because the `(captured_at, id)` checkpoint can otherwise leapfrog a row forever. `onCaptureReady` clears `pendingCapture` *before* its awaits (`controller.ts:329`), so capture N can still be awaiting `getSnapshot()` when N+1 is triggered and completes first. N becomes eligible after N+1, but its `captured_at` is earlier — if the checkpoint has already advanced past it, N is skipped and never reconsidered. Ten seconds is far longer than a snapshot round-trip and costs nothing at this altitude.

**2. Resolve known resources immediately.** One ordered lookup over enabled `desk_matchers`: `confirmed` first, then specificity (derived from operator and normalized-pattern length), then field as tie-breaker (`path > title > bundle > resource`), then oldest id. Check `desk_suppressions` before accepting an unconfirmed matcher; a suppressed resource/thread pairing behaves as unmatched. When a matcher wins, snapshot its `thread_id`, id, confidence, and attribution time onto the segment. Historical segments do not silently change when that matcher is later corrected.

The unique constraint on `(field, operator, normalized_pattern)` prevents two matchers disagreeing about the same pattern, but `ON CONFLICT` behavior depends on authority:

| Existing matcher | Incoming write | Result |
|---|---|---|
| None | Model inference | Insert exact-resource matcher, `confirmed=0`, `source='inferred'` |
| Unconfirmed, same thread | Model inference | Refresh confidence, example, and `last_seen_at`; do not change authority |
| Unconfirmed, different thread | Model inference | Do not mutate it; hold the alternative only as a candidate question |
| Confirmed | Model inference | No mutation; the user-approved matcher wins |
| Any exact-resource matcher | Plain user block reassignment | Re-point to the selected thread, set `source='user'`, preserve `confirmed=1` if it was already confirmed, otherwise remain unconfirmed; update the block and its segment attribution snapshots in the same transaction |
| Any matcher | Explicit concrete-matcher confirmation | Re-point, set `confirmed=1`, `source='user'`, reset hits, and replace the example |

Inference code uses a guarded upsert that cannot update a confirmed row. User reassignment and explicit confirmation use separate statements; there is no generic “upsert matcher” helper capable of erasing authority.

**3. Smooth over time, not over a count.** Sense capture cadence is irregular — `eventDrivenCapture` fires on app switch and `clipboardCapture` on clipboard change, so "the last eight captures" can span thirty seconds during heavy switching or several minutes while idle. Smooth over a **rolling three-minute window of attributed segment presence time**, and require the leading thread to hold a clear majority of that window before declaring a switch. Persist the winning candidate, matcher, resource signature, candidate start, and accumulated presence in `desk_runtime`; reconstruct the disposable window from segment attribution snapshots after restart. Unknown resources may form a segment but do not surface a named block until inferred.

**4. Infer unknowns on demand and in batches.** When an unknown candidate reaches three minutes, enqueue an immediate inference so the Ask can still be timely — capped at **six immediate calls per hour**, after which unknowns fall through to the sweep and the Ask simply arrives late. A 15-minute sweep catches shorter unknown segments and performs startup back-fill. Both paths select unresolved segments whose linked captures have reached a terminal text state, then collapse all pending unknowns into one 200–500-token request: app names, deduplicated titles, structured paths, and a few already-redacted text excerpts. A capture with failed or empty text is still eligible for metadata-only classification; it must not remain unresolved forever. `attribution_state`, attempts, and `retry_at` make late OCR/accessibility results and failed model calls retryable without rewinding segmentation. Never send screenshots or image paths.

**Redact titles and paths — they have never been through `redact()`.** Only *extracted* text is redacted, once, in `text-router.ts:88`. `window_title` is written completely raw at trigger time (`controller.ts:108-120`), so a browser tab reading `MyBank — Account ••••1234`, or an editor title holding a token, sits unfiltered in `sense_captures` today. Sense gets away with that because titles are only ever displayed back to their owner. Desk does not, because it **transmits** them to a model and **persists** them in `evidence_json` and matcher `example_json`. Run `redact()` over every title and path at prompt assembly *and* before persisting evidence or examples. Note `redact()` returns `string | null` — for a title, `null` means drop that title, not drop the segment.

**5. Persist an unconfirmed matcher, never an automatic rule.** The model assigns an existing thread or proposes one provisional thread, with confidence and an optional narrow matcher candidate. Subject to the authority matrix, its answer may write a `desk_matchers` row with `confirmed = 0`, scoped to the exact resource. It also snapshots the accepted attribution onto unresolved segments for that resource. `confirmed` flips to 1 only on explicit user approval of a concrete pattern. Silence may commit the current block but never promotes a matcher.

**6. Ask under the persisted interruption budget.** A high-confidence stable candidate may create one pending `thread_switch` question. Rejecting it is one transaction: mark the question rejected; increment `desk_suppressions`; disable/delete the matching unconfirmed resource matcher if it points at the rejected thread; clear or restore the affected segment/candidate attribution; and re-resolve the block to its previous thread or unknown state. Suppress that pairing for the rest of the day after one rejection and permanently after three. The suppression check happens before unconfirmed matcher resolution, so “No” changes behavior rather than merely hiding the next question.

On expiry, mark the question `auto_accepted` and commit only that block. A linked todo may create a `todo_started` question under the same global budget; accepting or expiring it changes that item's status to `in_progress`, while rejecting it changes no attribution and is suppressed for that block. `last_assertion_at` enforces the ten-minute global budget across restarts. Validate each question kind's required foreign keys in the data layer because SQLite cannot express the useful union cleanly.

**7. Write the re-entry note at a confirmed departure.** Use only the last 30 minutes of linked, already-redacted text. Redact the assembled prompt again before model submission and redact the returned note before persistence. If either pass detects sensitive content, store no note and mark `note_status='failed'`. Notes are editable; a user edit sets `note_status='edited'` and is never overwritten.

#### Cost

Haiku pricing, 8 h days, 22 days:

| Strategy | Ships in | Calls/day | ~Cost/mo |
|---|---|---|---|
| Rule cache, LLM only on a miss | Rize | → 0 | cents |
| **Batched summary every 15 min** | **Screenpipe** | **32** | **$1.30** |
| Frame batch every 15 min | Dayflow | 64 | $3 |
| Per-capture, every 5 min | DoneThat | 96 | $6.50 |
| Per-capture, every 40 s | ScreenMind | 720 | $100 |

The rules/cache row plus the batched-summary row is the steady-state target. The immediate unknown-resource call can raise the first-week total, so instrument calls, tokens, latency, and cache hit rate during the Phase 2 dogfood. Ship only if steady state trends toward the batched estimate without sacrificing the three-minute interaction contract.

#### Implementation shape

`src/daemon/desk/worker.ts` clones two existing patterns rather than inventing a third:

- **From `src/daemon/sense/worker.ts`** — the poll → batch → mark loop. Desk does not need the Sense FTS `safeUpdate` workaround because it never updates FTS-backed text.
- **From `src/daemon/memory/service.ts`** — the serialized queue (`let queue: Promise<void> = Promise.resolve()`), the `(processed_capture_at, processed_capture_id)` checkpoint advanced only after a successful transaction, strict parse-and-validate that accumulates errors rather than throwing, and `redact()` before model submission and persistence.

Inference goes through `runPiTextPrompt(prompt, 'fast')` (`src/daemon/pi/runtime.ts:537`) — tool-less, in-memory, no extensions/skills/context files. **Do not** use `runAgentConsult`; a full agent session per batch is far more machinery and cost than a classification needs.

**No scheduler.** `plans/bond-jobs.md` specs a jobs table and tick loop and remains unimplemented. Do not build it for this — a `setInterval` matches the existing hourly retention sweep in `sense/storage.ts`.

### Three timescales, kept separate

Empirically settled, from 477 observation-hours of knowledge workers (González & Mark, CHI 2004) and a two-component Gaussian-mixture fit over ten activity datasets (Halfaker et al.).

| Constant | Value | Job |
|---|---|---|
| **Noise floor** | ~3 min | Average dwell on one window (~2 min 11 s per document). Below this you are looking something up. **Never surface a named block this short**, though its segment may later merge into a longer block. |
| **Working sphere** | ~11–12 min | Average dwell in one coherent thread, 10–12 per day. **This is the altitude Desk operates at.** |
| **Session gap** | ~60 min | The evidence-based idle threshold. The familiar 30-minute figure traces to a 1995 rounding decision (Catledge & Pitkow: 9.3 min mean + 1.5 SD ≈ 25.5, rounded up) and has been shown to perform no better than random for task boundaries. |

Sense's existing 60-**second** idle threshold is a *presence* signal — is the user at the keyboard. It is a fourth, separate thing and must not be reused for task boundaries. A five-minute coffee break pauses `presence_seconds`; it does not end a thread.

**How `presence_seconds` is actually derived.** Captures do not arrive on a metronome — `eventDrivenCapture` fires on app switch and `clipboardCapture` on clipboard change, so a burst of six captures in ten seconds must not be credited as six intervals of presence. Credit each capture `min(gap_since_previous, 2 × captureIntervalSeconds)`, where the gap is measured within the same segment and the cap absorbs both bursts and short stalls. Read `captureIntervalSeconds` **from settings** — it is user-configurable (`DEFAULT_SENSE_SETTINGS.captureIntervalSeconds` is merely the default of 15), and hardcoding 15 would quietly mis-scale every duration for anyone who changed it. A gap longer than the idle threshold credits nothing.

### RPC surface

Added to `src/shared/rpc-schema.ts` (`RpcMethods` + `RPC_METHOD_NAMES` — omitting either is a compile error), handled in `src/daemon/server.ts`, proxied automatically through `buildDaemonSurface` in `src/shared/bond-surface.ts`:

| Method | Purpose |
|---|---|
| `desk.status` | Running state, Sense state, current thread, presence elapsed, pending question |
| `desk.setRunning` | Explicitly start/stop Desk without changing Sense settings |
| `desk.blocks` | `{from, to}` → blocks with threads, segments, and notes |
| `desk.threads` / `desk.createThread` / `desk.renameThread` | Thread catalogue |
| `desk.mergeThreads` / `desk.archiveThread` | Explicit lifecycle operations |
| `desk.reassign` | `{blockId, threadId, confirmedMatcher?}` → optimistic reassignment using the authority matrix; updates the block/segment snapshots and exact-resource matcher, and confirms a concrete pattern only when explicitly supplied |
| `desk.answer` | `{questionId, accepted}` → resolves a pending Ask |
| `desk.updateNote` | User edit; marks the note edited so inference cannot overwrite it |
| `desk.matchers` / `desk.disableMatcher` / `desk.deleteMatcher` | The buried rules editor — lists confirmed matchers with their examples |
| `desk.ensureToday` | Idempotently creates/repairs the Today collection and returns today's items |
| `desk.linkTodo` / `desk.unlinkTodo` | Explicitly associate or detach a collection item and thread |
| `desk.carryTodo` | Set an unfinished item's `day` to the user's current local day; never runs implicitly |

One notification: `desk.changed`, broadcast on any block/rule/state change so the notch, the right panel, and a second window stay in lockstep.

**A `bond desk` CLI subcommand is not optional — it is the only way Phase 2's go/no-go can happen.** The plan calls for a day of dogfooding "read the blocks and inference metrics," but no existing subcommand does generic RPC, and no UI exists until Phase 3. Add `src/cli/desk.ts` alongside `media`/`sense`/`library` (bundled by `npm run build:cli`): `status`, `blocks [--day]`, `threads`, `matchers`, `answer <id> yes|no`, and `stats` — where `stats` is the home for the instrumentation the ship criteria demand (model calls, tokens, immediate-vs-swept ratio, cache hit rate, unknown-resource latency). Without `stats` those numbers have nowhere to live and the trial produces an impression instead of a decision.

Wire it through the full existing notification path: add it to `RpcNotifications`, add `onDeskChanged` to the daemon client, bridge it in main to `broadcast('bond:deskChanged')`, and expose typed `onDeskChanged` handlers in preload and the web shim. `registerWindow()` alone does not subscribe main to a new daemon notification.

Plus a Pi tool, `open_desk`, so *"let's get to work"* is the real agent deciding rather than a string match. This is not merely onboarding's `show_panel`: add a new `{kind: 'open_desk'}` `TaggedChunk`, handle it in `useChat`, and dispatch a typed Electron-local `openDesk()` call through preload to main. Main owns idempotent create/show; the web shim implements `openDesk()` as a supported no-op returning `{opened:false, reason:'desktop_only'}`. If Sense is disabled, the tool returns a clear result and opens Desk in a non-recording state with an Enable Sense action. If back-fill is pending, the tool returns `queued:true`; main opens only after `desk.status` reports populated or definitively empty. A second call focuses nothing and simply reveals the existing non-activating window.

---

## Notch mechanics

All of this was verified by live probe on a 16" M4 Max, macOS 26.5, Electron 41.10.2.

### The load-bearing option

```js
const win = new BrowserWindow({
  width: 640, height: 240,
  frame: false,
  transparent: true,
  hasShadow: false,
  resizable: false,
  movable: false,
  skipTaskbar: true,
  enableLargerThanScreen: true,   // ← REQUIRED, or y is clamped to the menu bar
  type: 'panel',                  // NSPanel nonactivating
  roundedCorners: false,          // you draw the notch shape in CSS
  acceptFirstMouse: true,
  fullscreenable: false,
  backgroundColor: '#00000000',
  show: false,
  webPreferences: { preload, backgroundThrottling: false }
})

win.setAlwaysOnTop(true, 'main-menu', 3)   // → NSWindow level 27  [measured]
win.setVisibleOnAllWorkspaces(true, {
  visibleOnFullScreen: false,              // ← likely a no-op on a panel; see below
  skipTransformProcessType: true           // ← or Bond loses its Dock icon
})
win.showInactive()
win.setIgnoreMouseEvents(true, { forward: true })   // default state: click-through
```

**`enableLargerThanScreen: true` is the whole feature.** Seven configurations were probed asking for `y: 0`; six returned `y: 33` **[measured]**. Only that flag returned `y: 0`. The mechanism is in `electron_ns_window.mm`'s `constrainFrameRect:toScreen:` — with the flag set **and `frame: false`**, Electron returns the requested rect verbatim instead of AppKit's constrained one. It landed in [PR #23976](https://github.com/electron/electron/pull/23976) explicitly so "frameless windows can be positioned exactly where the developer wants them to be, even if that's behind the dock or the menu bar." The docs describe it only as *"Enable the window to be resized larger than screen,"* which is why nobody finds it.

### Window level: 27, not screen-saver

Measured `kCGWindowLayer` values **[measured]**:

| Call | Level | Above menu bar? |
|---|---|---|
| `('floating')` | 3 | no |
| `('status', 2)` / `('main-menu', 3)` | **27** | **yes** |
| `('pop-up-menu')` | 101 | yes |
| `('screen-saver')` | 1000 | yes |
| `type: 'panel'` at construction | 3 | no — must override after |

Reference points in the same dump: the WindowServer **Menubar is layer 24**; **Control Center menu bar extras are layer 25**; **open menus are 101**.

So level 27 is above the bar and above the status items, but *below* open menus — meaning any menu the user opens correctly draws over Desk. `screen-saver` would paint over open menus, which is the single most common way these overlays look broken. boring.notch uses `.mainMenu + 3` for exactly this reason.

`relativeLevel` is added to the NSWindow level as a raw integer, which is how arbitrary levels are reachable. Note `screen-saver` measured **1000** on macOS 26 where older references list 101 — always pass the *string*, never a number.

### `type: 'panel'`

From `electron_ns_panel.mm`, this adds `NSWindowStyleMaskNonactivatingPanel` at runtime and forces `canJoinAllSpaces | fullScreenAuxiliary`. It gives:

- **Non-activating** — clicking does not bring Bond to the front (Spotlight/Alfred behaviour)
- **Key focus still possible** → **a panel can receive text input**, which is the crucial difference from `focusable: false`
- **Level forced to floating (3) at construction** → `setAlwaysOnTop` must be called *after*

Known caveats: a harmless runtime log (`NSWindow does not support nonactivating panel styleMask 0x80`), and **panels are invisible to accessibility APIs** — meaning `bond-accessibility-helper` will not see Desk. That is a feature here: Sense cannot capture Desk's own contents.

**`visibleOnFullScreen: false` probably does nothing on a panel.** `electron_ns_panel.mm` overrides `setCollectionBehavior` to unconditionally OR in `canJoinAllSpaces | fullScreenAuxiliary` on every call, so the panel class puts the behaviour back after Electron clears it. Fullscreen suppression must therefore rest entirely on the CGWindowList heuristic driving an actual `win.hide()` — treat the flag as intent, not enforcement, and verify in Phase 0.

### Geometry — Electron exposes nothing

`screen.getPrimaryDisplay()` on Electron 41.10.2 has no `safeAreaInsets`, no `auxiliaryTopLeftArea`, no safe-area field of any name **[measured]**. [electron#31478](https://github.com/electron/electron/issues/31478) requested exactly this and was closed **not planned**. CSS `env(safe-area-inset-top)` returns **`0px`** **[measured]** — Chromium only wires it on iOS/Android.

Measured on this machine **[measured]**:

```
frame                1728 × 1117
safeAreaInsets.top   32
auxiliaryTopLeftArea  (0,   1085, 771, 32)
auxiliaryTopRightArea (956, 1085, 772, 32)
notch                185 × 32      (1728 − 771 − 772)
menu bar             33            (notch height + 1)
```

**Published tables are wrong.** The widely-circulated "220 × 38" for the 16" is the *More Space* scaled mode, not default. The notch is a fixed number of *physical* pixels, so its point size scales linearly with framebuffer width: `notchPt = 185 × (widthPt / 1728)` on this model. **Never hardcode; recompute on `display-metrics-changed`.**

**Detect the menu bar with `workArea.y - bounds.y`, never `bounds.height - workArea.height`.** The latter is wrong the moment the Dock is at the bottom, because it silently includes Dock height. (On this machine the Dock is on the *left*, so the naive expression happens to return the right number — a coincidence that would hide the bug.)

Also: on a secondary display with "Displays have separate Spaces" off, `workArea.y === bounds.y` because there is no menu bar there at all. So a zero result means "no bar *on this display*," not "no bar exists."

### The native helper

Bond already ships three Obj-C helpers through `scripts/build-native-helpers.sh` → `out/daemon/bin/sense/`, resolved by `resolveHelperPath()` in `src/daemon/sense/helpers.ts`. Add a fourth, `src/native/notch-helper.m`, ~40 lines, printing JSON per `NSScreen`:

```objc
NSEdgeInsets i = s.safeAreaInsets;
NSRect l = [s.auxiliaryTopLeftArea  rectValue];
NSRect r = [s.auxiliaryTopRightArea rectValue];
BOOL notched = i.top > 0 && s.auxiliaryTopLeftArea && s.auxiliaryTopRightArea;
// notchWidth  = s.frame.size.width - l.size.width - r.size.width
// notchHeight = i.top
// menuBarHeight = NSMaxY(s.frame) - NSMaxY(s.visibleFrame)
// displayID = [s.deviceDescription[@"NSScreenNumber"] unsignedIntValue]
```

Compile with `-framework AppKit -framework Foundation`, same as `window-helper.m`. Requires macOS 12+.

Match native screens to Electron displays via `CGDirectDisplayID` — on macOS Electron's `Display.id` **is** the `CGDirectDisplayID` **[measured: `1`, matching `CGMainDisplayID()`]**.

Skip [`node-mac-notch`](https://github.com/codebytere/node-mac-notch) — 11 stars, no published releases, and it buys a native-module rebuild burden for 40 lines the existing build script already handles.

**Heuristic fallback** if the helper is missing (packaged builds, build failure) — good enough to render a shape, since a few points of slop at the notch edge is invisible:

```js
const menuBar = d.workArea.y - d.bounds.y
const notched = d.internal && menuBar >= 30
const height  = menuBar - 1
const width   = Math.round(185 * (d.bounds.width / 1728))   // 16"; 1512 basis for 14"
```

### Animation: fixed window, CSS content

**Never animate `setBounds`.** `win.setBounds(bounds, true)` **blocked the main process for 342 ms** **[measured]** — it is a synchronous, fixed-duration `NSWindow setFrame:display:animate:` that cannot be interrupted, retargeted, or eased. Even un-animated `setBounds` is a WindowServer round trip per call, and resizing a transparent window per-frame is the exact path that produces the known flicker and shadow artifacts.

Instead: **create the window once at fully-expanded size, position it once, never resize it.** All motion is CSS `transform` on a child element inside that fixed rect. This is what boring.notch does (`openNotchSize` 640 × 190 plus 20 pt `shadowPadding`, positioned once via `setFrameOrigin`) and what `electron-dynamic-island` does in Electron.

```css
.notch {
  position: fixed; top: 0; left: 50%;
  transform: translateX(-50%) scaleY(var(--sy));
  transform-origin: top center;
  will-change: transform;
  transition: transform .38s cubic-bezier(.32, .72, 0, 1);
  border-radius: 0 0 var(--r) var(--r);
}
```

`hasShadow: false` (native shadows don't render on transparent windows) — draw it with CSS `filter: drop-shadow()` and reserve ~20 px of transparent padding inside the window for the bleed.

### Click-through: poll the cursor, don't listen

**Renderer `mousemove` is not usable here.** With `setIgnoreMouseEvents(true, {forward: true})`, forwarded mouse-move on macOS only fires **while a button is held** ([electron#26718](https://github.com/electron/electron/issues/26718)), and forwarding silently stops when certain non-Electron windows hold focus ([#33281](https://github.com/electron/electron/issues/33281)).

Poll from main instead. `screen.getCursorScreenPoint()` benchmarked at **~2 µs/call** (1000 calls in 2 ms) **[measured]** — 60 Hz polling is free.

```js
setInterval(() => {
  const p = screen.getCursorScreenPoint()
  // Renderer reports these rects on each discrete state/layout change. Main
  // validates and clamps them to the fixed window before storing them.
  const hotRects = expanded
    ? [notchTopRect(), panelBodyRect({ minY: menuBarHeight })]
    : [notchHotRect()]
  const inside = hotRects.some(rect => pointIn(p, rect))
  if (inside === clickThrough) {
    clickThrough = !inside
    win.setIgnoreMouseEvents(clickThrough, { forward: true })
    win.webContents.send('desk:hover', inside)
  }
}, 16)
```

Once non-click-through, the renderer *does* get real events — use those for buttons and text input, with the poll as the outer gate. `panelBodyRect.minY` is clamped below the menu bar; the only interactive rectangle above it is the physical notch x-range. Transparent shadow padding is never interactive.

**Hard rule: never leave a non-click-through region overlapping `y < menuBarHeight` outside the notch's own x-range.** That is how you break the menu bar for the entire machine.

### Following the user's display

Anchor to **`bounds`, never `workArea`** — you want the physical top edge, and it makes the no-menu-bar secondary display case fall out for free.

```js
const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
win.setBounds({
  x: Math.round(d.bounds.x + d.bounds.width / 2 - W / 2),
  y: d.bounds.y,
  width: W, height: H
})
```

`enableLargerThanScreen` is still required on non-notched and external displays — the clamp is per-screen, not per-notch. Non-notched rest shape: **300 pt × menu-bar height**, centred, squared top corners, rounded bottom (DynamicNotchKit's fallback).

Re-anchor on `display-added`, `display-removed`, and `display-metrics-changed` (when `changedMetrics` includes `bounds`, `workArea`, or `scaleFactor`) — **debounced ~300 ms and re-applied once more after ~1 s**, because WindowServer has not settled when the event fires. Always force a full re-anchor on `powerMonitor` `'resume'`; waking is the most common way these windows end up on the wrong display or back at `y: 33`.

While Rest is collapsed, the same cursor poll records the display under the pointer. If the pointer remains on another display for one second, re-anchor there once. Never move while Glance, Ask, or Open is visible; defer the move until Rest. This makes “follow the user's display” real without making the panel jump underneath an active interaction.

`Display.id` can change across unplug/replug — if stability matters, get `CGDisplayCreateUUIDFromDisplayID` from the native helper.

### Window plumbing

Quick chat is gone, so the pattern to follow is the **separate HTML entry**: `desk.html` + `desk-main.ts` + `DeskWindow.vue`, plus a `desk` input in `electron.vite.config.ts`'s `rollupOptions.input` alongside `main`/`settings`/`viewer`. Register with `registerWindow()` from `src/main/window-router.ts` to receive chunk routing and entity broadcasts.

---

## Phases

### Phase 0 — The probe · ~30 min

Two things could not be verified without driving the UI, and both are load-bearing:

1. Does the menu bar stay **clickable** under a level-27 window with `setIgnoreMouseEvents(true, {forward:true})`?
2. Does an open menu (level 101) correctly draw **over** the panel?

One throwaway file in the scratchpad, using the BrowserWindow block above. Test both a 185 × 32 Rest shape and a fully expanded 640 × 240 panel with the real two-rectangle hit-test. Click Apple/menu titles, status extras, and panel controls; move repeatedly across the notch/menu/panel boundaries. If the menu stays clickable outside the notch and opens over the panel, the direction is validated. If not, fall back to a floating lozenge below the menu bar — everything else in this plan survives unchanged.

Also confirm the CGWindowList fullscreen heuristic against native fullscreen, borderless video, Stage Manager, and a maximized-but-not-fullscreen window. The ship invariant is conservative: fullscreen may hide Desk too often, but Peek/Ask must never appear over a genuine fullscreen app. **Specifically check whether `visibleOnFullScreen: false` has any effect on a `type: 'panel'` window** — the panel class re-ORs `fullScreenAuxiliary` into every collection-behaviour write, so the flag is expected to be inert and `win.hide()` is expected to be the only thing that works.

### Phase 1 — Two Sense bugs, fixed regardless of Desk · ~1 h

#### 1a. The capture wedge — one failed screenshot stops Sense until restart

`src/main/sense.ts:31-36`:

```js
const imagePath = await captureScreen(captureDir)
if (imagePath) {
  await client.senseCaptureReady(captureId, imagePath)
}
```

If `captureScreen` returns `null` — no matching `desktopCapturer` source, a transient permission blip — `sense.captureReady` is never called. If it throws, the `catch` logs and swallows. Either way the daemon's `pendingCapture` is never cleared, and `controller.ts:88` refuses every subsequent capture: `if (pendingCapture) return`. The 30-second watchdog only reconciles *presence* state; it does not touch `pendingCapture`. **One lost capture silently ends the recording day.**

Sense degrades gracefully into a timeline with a hole. Desk does not — its presence clocks and switch detection are starved of their entire input, and the panel confidently shows a stale thread forever.

Fix both ends:
1. **Daemon:** a pending-capture timeout in the controller — if `onCaptureReady` hasn't landed within ~30 s, clear `pendingCapture`, delete the orphaned row, and resume.
2. **Main:** on a null or thrown capture, report the failure back to the daemon rather than swallowing it, so the wedge is cleared immediately instead of at timeout.

Regression test: request a capture, never call `captureReady`, assert the next interval tick still produces one.

#### 1b. The accessibility path never runs

`text-router.extractText()` accepts a `pid`, but there is no `pid` column on `sense_captures` and `sense/worker.ts:92` never passes one — so **accessibility extraction never runs and every capture goes through OCR**. Screenpipe treats the accessibility tree as *primary* and OCR as fallback, for good reason: the tree gives structure, OCR gives soup.

1. `ALTER TABLE sense_captures ADD COLUMN pid INTEGER` (pragma-guarded, in the migration chain)
2. Persist `pid` from the window snapshot in `controller.triggerCapture()`
3. Pass it through in `worker.ts`
4. Regression test in `sense/text-router.test.ts` asserting the accessibility path is reached when a pid is present

Every inference downstream improves for free.

### Phase 2 — The daemon half, no UI · ~1–2 days

Everything in *Architecture* above: Desk-owned tables, thread catalogue, fast segmenter, deterministic matching, slow inference queue, persisted questions/suppressions/runtime state, summary builder, temporal smoothing, the retention sweep, the RPC surface, and **the `bond desk` CLI including `stats`**. Add the `open_desk` Pi tool and `TaggedChunk`, but leave native window handling for Phase 3.

The daemon behavior is testable through `bin/bond` with no window — which is exactly why the CLI ships in this phase and not later. The `open_desk` end-to-end path is not complete until Phase 3. Per CLAUDE.md every new `.ts` gets a `.test.ts` sibling; data-layer tests build an in-memory SQLite db, run migrations, and exercise every exported function. Use fake clocks and a fake model to cover three-minute dwell, ten-minute silence, candidate restart reconstruction, expiry, rejection rollback, three-strike suppression, every matcher-authority transition, matcher re-teaching, metadata-only inference, session gaps, timezone rollover, failed inference retries, the immediate-inference ceiling, the blacklist-delete race, both retention-cleanup orders, edited-note graduation, and inferred-thread expiry.

**Run it for a full day against real Sense data before designing a single pixel.** Classification quality decides whether the panel is worth building at all — and if the rules-plus-batch approach produces mush, that is much cheaper to discover here than after the notch shell exists.

Also fix while in the neighbourhood: `sense.now` returns `{capture, state}`, and at least one caller historically read a non-existent `.apps` field. Check any remaining consumers.

### Phase 3 — The notch shell and native plumbing · ~1.5 days

- `notch-helper.m` + `build-native-helpers.sh` entry + geometry resolution with heuristic fallback
- `window-helper.m` extended to emit window `layer` + `frame`; `DetectedWindow` widened; Desk's own 1–2 Hz fullscreen poll in main, independent of Sense's gating
- `desk.html` / `desk-main.ts` / `DeskWindow.vue` / rollup entry
- `src/main/desk.ts` — idempotent window creation, level, validated hit-region poll, display following, fullscreen suppression, power-monitor re-anchor
- `openDesk()` preload/main IPC, web no-op, `open_desk` chunk handling, disabled-Sense and delayed-back-fill states
- **Rest** and **Ask** states only. No Glance, no Open panel.

This is usable alone, and it is where the anti-annoyance rules get proven under real conditions. Live with it for a few days before building Phase 4.

### Phase 4 — The panel, parking, and return · ~1–2 days

- **Glance** and **Open** states
- Thread create/rename/merge/archive
- Optimistic reassignment, resource attribution, and explicit safe-matcher confirmation
- Re-entry note generation at departure, double redaction, editable-note protection, and `runPiTextPrompt` fast tier
- Idempotent Today collection, local-day rollover, carry-forward behavior, and thread links
- The big review view as a **fifth right-panel** — `App.vue:133`'s `RightPanelContent` union plus `validRightPanels` and the template. ~1 hour, because the pattern exists four times.

Parking notes last, when there is real attributed data to write them from.

---

## Implementation order

| # | Step | Cost | Blocking? |
|---|---|---|---|
| 0 | Rest/expanded hit-test + fullscreen probe | 30 min | Yes — validates the whole surface direction |
| 1 | Capture-wedge fix + `pid` column/accessibility path | 1 h | No — both are live Sense bugs, valuable alone |
| 2 | Desk tables + migration + restart fixtures | 3–4 h | Yes |
| 3 | Thread catalogue + fast segmenter + deterministic matcher | 4–6 h | Yes |
| 4 | Inference queue + smoothing + questions/suppressions | 4–6 h | Yes |
| 5 | RPC surface + `open_desk` chunk/tool + retention sweep | 2–3 h | Yes |
| 5b | `bond desk` CLI incl. `stats` instrumentation | 1–2 h | **Yes — step 6 is blind without it** |
| 6 | *Live with it for a day. Read the blocks and inference metrics.* | — | **Yes — go/no-go** |
| 7 | Native notch helper + `window-helper.m` layer/frame | 2 h | Yes |
| 8 | Desk window + hit regions + fullscreen poll + display behavior | 5–7 h | Yes |
| 9 | Native `openDesk()` plumbing + Rest + Ask | 3 h | Yes |
| 10 | *Live with it for a few days.* | — | **Yes — annoyance check** |
| 11 | Glance + Open panel + thread management | 4–6 h | No |
| 12 | Reassignment + matcher confirmation | 2–3 h | No |
| 13 | Re-entry notes + editing | 3–4 h | No |
| 14 | Today collection + links + right panel | 3–4 h | No |

Two deliberate stops (6 and 10). Both are cheap relative to the work that follows and both can kill or reshape the feature before the expensive panel work.

---

## Known gaps

- **Fullscreen detection is heuristic**, and needs `window-helper.m` extended before it can run at all. CGWindowList can confuse borderless full-display windows with native fullscreen. Desk deliberately fails closed and hides in either case; private CGS APIs remain out of scope.
- **Window titles in `sense_captures` are unredacted today.** Desk redacts on the way out, but the existing rows Sense already wrote are raw. Nothing in this plan retroactively cleans them, and back-fill reads them — so back-fill must redact on read, not assume the store is clean.
- **Notch width via heuristic is extrapolated**, not measured, on any model other than this one. The native helper removes this; the fallback keeps it cosmetic.
- **Transparent-window flicker** ([electron#20325](https://github.com/electron/electron/issues/20325)) is historical but the mitigations are cheap and already in the plan: `backgroundColor: '#00000000'`, `show: false` → `showInactive()` after load, and never moving the window.
- **Offline work is invisible.** Calls, whiteboards, and time away from the desk produce no captures. This is why time is always approximate and why there is no "total hours" anywhere.

---

## Resolved v1 decisions

1. **Parking notes are private-by-default artifacts.** Redact inputs before submission, redact model output before persistence, store nothing on a redaction hit, and allow user edits that inference never overwrites.
2. **Desk opens only through explicit intent.** `open_desk`, a UI command, or persisted `running=true` at app launch may open it. Observed activity alone never turns Desk on or opens the panel.
3. **Threads are hidden, not auto-archived, after seven untouched days.** Archival and merging require an explicit user action.
4. **A block may bridge short absence but not the 60-minute session gap.** Its displayed elapsed time is summed `presence_seconds`, never wall-clock span.
5. **Today uses the user's current local timezone.** Midnight changes the query, not stored dates; unfinished items remain on their original day until the user explicitly carries them forward.
6. **Sense state controls observation, not access.** Disabled/suspended means historical/read-only Desk; idle/paused freezes presence; recording enables segmentation and inference.
7. **A rejected suggestion is negative evidence only.** Rejection removes the unconfirmed attribution that produced the suggestion, restores or clears the candidate block, and suppresses the pairing; three rejections make that suppression permanent. Silence commits one block and teaches no confirmed rule.
8. **Desk-derived screen data expires with Sense's text retention.** Expired segments, blocks, generated summaries/notes, unconfirmed matchers, matcher examples, resolved questions, and orphan inferred threads are swept. User-authored threads, todos, confirmed patterns, suppressions, and graduated `user_note` values remain.

---

## Ship criteria

- Known-resource switches never surface before three minutes and surface promptly after the threshold; unknown-resource latency, model-call count, tokens, and cache-hit rate are recorded during dogfood, and immediate inference respects its hourly ceiling.
- Restarting during a candidate switch, pending Ask, cooldown, failed inference, or paused Sense state neither duplicates work nor resets candidate presence or the annoyance budget. Segment attribution snapshots reconstruct the same rolling window.
- Model output cannot mutate or demote a confirmed matcher. Silence and generic bundle corrections cannot promote one. Every confirmed matcher has a user-approved concrete pattern visible in Settings; its captured example is visible only until retention expiry. Re-teaching an existing pattern to a different thread succeeds instead of erroring.
- Rejecting an Ask disables/deletes its unconfirmed matcher, restores or clears the affected attribution, and changes the next resolution result; suppression alone is not considered a correction.
- A capture deleted by the post-capture blacklist recheck leaves no segment, signature, or evidence behind. A capture whose image was purged by age *or* by the storage cap is still reachable by the sweep. A capture whose `onCaptureReady` completes out of order is never leapfrogged by the checkpoint.
- No window title or path reaches a model, `evidence_json`, or `example_json` without passing through `redact()`.
- A screenshot failure in the main process does not stop the next capture.
- Redaction occurs before every Desk model submission and before note persistence. An edited block note is never overwritten, graduates to the newest thread `user_note`, and its expired source block is then removed. All other captured examples, evidence, summaries, generated notes, unconfirmed matchers, and orphan inferred threads are gone after `textRetentionDays`.
- The fully expanded window leaves Apple menus, menu titles, and status extras clickable outside the physical notch; open menus render over Desk.
- Desk emits no Peek or Ask and is not visible over a fullscreen app. Disabled/suspended Sense produces no new duration or inference.
- Today survives repeated initialization, timezone changes, and midnight rollover without duplicating its collection or silently changing an item's day or status. Link, unlink, and carry-forward operations are explicit, idempotent, and independently tested.
- Thread merge/archive operations are transactional and cannot leave blocks, matchers, suppressions, or todo links pointing at missing threads.

---

## Prior art

**Products** — [Rize](https://docs.rize.io/categories-and-tracking-rules/how-categorization-works) (2-min wait → classify → write a persistent rule; widget hides on hover; 60 fps → 1 fps took CPU 25% → 1%) · [Timing](https://timingapp.com/help/rules) (option-drag assigns *and* creates a rule; first matching project wins) · [Timely](https://www.timely.com/help/handbook/autosheet/timely-autosheet/) (AI drafts in private mode; drag memories between timeline and entry to correct) · [Memtime](https://www.memtime.com/blog/ai-time-tracking) (refuses AI on review-burden grounds; zoomable 1–60 min buckets instead) · [ActivityWatch](https://docs.activitywatch.net/en/latest/features/categorization.html) (pure regex, deepest match wins, no ML ever planned) · ManicTime (deterministic rules applied retroactively to all history).

**Capture systems** — [Screenpipe](https://docs.screenpipe.com/architecture.md) (event-driven capture, accessibility-first with OCR fallback, `GET /activity/summary` at 200–500 tokens, scheduled pipes running Pi with `claude-haiku-4-5`, `Semaphore(1)` so inference never stacks) · [Dayflow](https://github.com/JerryZLiu/Dayflow) (1 fps → 15 s chunks → 15-min VLM batches; SQL `LAG()` window functions merge consecutive similar activities — segmentation in SQL, not a model) · Rewind ([teardown](https://kevinchen.co/blog/rewind-ai-app-teardown/): 0.5 fps, no dedup, 180 MB/hr video, 20–40% battery reduction) · Microsoft Recall (change-gated capture, VBS enclave, on-by-default sensitive-content filtering) · [OpenRecall](https://github.com/openrecall/openrecall) (MSSIM < 0.9 dedup threshold).

**Research** — Shen, Li & Dietterich, *Real-Time Detection of Task Switches of Desktop Users*, [IJCAI 2007](https://www.ijcai.org/Proceedings/07/Papers/460.pdf) (the false-alarm finding; queue ℓ = 8; Viterbi; `r = 10` silencing; skip if segment > 25 s) · Shen et al., *TaskPredictor2*, [IUI 2009](https://web.engr.oregonstate.edu/~tgd/publications/IUI2009-TP2.pdf) (online Passive-Aggressive, 180× speedup; switch-specific features like "resources closed in the last 60 s") · Oliver et al., *SWISH*, [IUI 2006](https://nuriaoliver.com/swish/iui2006-oliver.pdf) (unsupervised; TF-IDF + PLSI over titles, plus a window-switching graph; ~70%, and 1-hour chunks raised recall to 76%) · Lill et al., *TaCoS*, [ICSE 2026](https://hasel.dev/wp-content/uploads/2026/01/TACOS-pre-print.pdf) (32 devs; shortest resumption lag, lost on task success, only last 30 min relevant) · González & Mark, [CHI 2004](https://ics.uci.edu/~gmark/CHI2004.pdf) and Mark et al., [CHI 2005](https://ics.uci.edu/~gmark/CHI2005.pdf) (the timing constants) · Halfaker et al., [arXiv:1411.2878](https://arxiv.org/pdf/1411.2878) (~1 h session threshold, not 30 min) · Mankoff et al., *Heuristic Evaluation of Ambient Displays*, CHI 2003 (interrupt / make-aware / change-blind).

**Notch implementations** — [boring.notch](https://github.com/TheBoredTeam/boring.notch) (`level = .mainMenu + 3`; `collectionBehavior = [.fullScreenAuxiliary, .stationary, .canJoinAllSpaces, .ignoresCycle]`; fixed window at `openNotchSize` + 20 pt `shadowPadding`; `getClosedNotchSize()` is the geometry reference) · [DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit) (cleanest `NSScreen` extensions; 300 pt × menu-bar-height non-notched fallback) · [electron-dynamic-island](https://github.com/IrtizaNasar/electron-dynamic-island) (CSS spring transitions in Electron — read for the animation approach, not the model-identifier geometry tables).

**Electron** — [`native_window_mac.mm`](https://github.com/electron/electron/blob/main/shell/browser/native_window_mac.mm) · [`electron_ns_window.mm`](https://github.com/electron/electron/blob/main/shell/browser/ui/cocoa/electron_ns_window.mm) · [`electron_ns_panel.mm`](https://github.com/electron/electron/blob/main/shell/browser/ui/cocoa/electron_ns_panel.mm) · [PR #23976](https://github.com/electron/electron/pull/23976) (`enableLargerThanScreen`) · [#31478](https://github.com/electron/electron/issues/31478) (safe-area request, closed not planned) · [#26718](https://github.com/electron/electron/issues/26718) (forwarded mousemove needs a held button).
