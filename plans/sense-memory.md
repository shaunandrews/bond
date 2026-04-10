# Sense Memory — Unified Memory System for Bond

> **Revision 2** — Updated based on architecture and product reviews. Key changes: use Sonnet instead of Haiku for debriefs, move auto-injection earlier in build order, add explicit memory pinning, add thread resolution, defer browse/clipboard channels, fix incorrect hook assumptions, flatten CLI, cap injection at 300 words.

## Overview

Extend Sense from screen-only awareness into a **unified memory system** with multiple input channels. Sense currently answers "what did the user see?" — this plan adds "what did Bond and the user do together?" and establishes Sense as the single interface for all contextual recall.

The architecture introduces **two tiers**:
- **Working memory** — auto-injected into system prompts, covering recent hours/days
- **Long-term memory** — searchable archive of all session debriefs, queryable on demand

No separate MEMORY.md file. Sense *is* the memory. The DB is the source of truth, the CLI is the interface, and auto-injection makes it useful without manual effort.

---

## Architecture

### Sense Channels

Sense becomes a multi-channel perception system. Each channel writes structured records to the same SQLite database, queryable through the same CLI and RPC interface.

| Channel | Source | Record Type | Priority |
|---------|--------|-------------|----------|
| `see` | Screen captures | `sense_captures` | ✅ Exists |
| `chat` | Session debriefs + pinned facts | `sense_debriefs`, `sense_facts` | 🔨 **Build first** |
| `browse` | Browser history | `sense_browse` | 💤 Defer (v2) |
| `clipboard` | Clipboard changes | `sense_clipboard` | 💤 Defer (v2) |
| `code` | Git activity | TBD | 💤 Defer (needs scheduler or git hooks) |

**Why defer browse + clipboard?** Both reviewers flagged these. Browse covers only Bond's built-in browser — a partial view that creates false expectations ("why does Bond remember this page but not that one?"). Clipboard is a privacy minefield for marginal utility — macOS has built-in clipboard history. Neither justifies the engineering cost before the core memory system is proven. The channel architecture supports adding them later with no changes to the core.

### Data Flow

```
Session archived/ended
        │
        ▼
Generate debrief (Sonnet call)
        │
        ▼
Write to sense_debriefs table
        │
        ▼
FTS5 index updated (automatic via trigger)
        │
        ▼
Available via: sense search, auto-injection
```

### Auto-Injection Pipeline

On every new chat message, the system prompt already gets recent screen context (last 5 minutes of `see` data). This plan extends that with chat memory:

```
New message arrives
        │
        ├── see:  Recent screen context (existing, last 5 min)
        │
        └── chat: Recent chat memory (new)
                ├── Pinned facts (explicit "remember this" items)
                ├── Open threads from recent sessions (deduplicated)
                ├── Recent decisions
                └── Last session summary
```

The injected context must be **compact** — hard cap at **300 words** (~400 tokens). The system prompt is already ~5,000 tokens; memory injection should not push it past 6,000. Prioritize:
1. Pinned facts (always loaded, highest signal)
2. Open threads from recent sessions — deduplicated, project-scoped when possible
3. Recent decisions with source session context
4. Last session summary for continuity

---

## Phase 1: Session Debriefs

### 1.1 Debrief Generation (`src/daemon/generate-debrief.ts`)

New module, following the pattern of `generate-title.ts`. Uses **Claude Sonnet** (not Haiku) to produce a structured debrief from a session's messages.

**Why Sonnet?** The decisions vs. open threads distinction requires judgment. Haiku produces good titles (2-4 words, trivial extraction) but debriefs are much more complex — classifying "maybe we should use Redis" as a decision vs. an open thread vs. a key fact requires nuance. Cost difference is negligible ($0.01 vs $0.003 per debrief). Quality difference is significant.

**Input:** All messages from the session (user + bond, skip tool meta noise)

**Minimum threshold:** Skip sessions with fewer than **5 substantive messages** (user + bond text messages, not tool/thinking/system). A 3-message "rename this file" / "done" / "thanks" session does not need a debrief.

**Output:**
```typescript
interface SessionDebrief {
  id: string
  sessionId: string
  sessionTitle: string
  projectId: string | null

  // Structured content
  summary: string           // 2-3 sentence overview
  topics: string[]           // Tag-like topic labels (e.g. "memory-system", "sense", "architecture")
  decisions: string[]        // Things agreed on or concluded
  openThreads: string[]      // Unresolved items, carry-forward work
  keyFacts: string[]         // Durable facts learned (preferences, conventions, etc.)

  // Metadata
  messageCount: number
  durationSeconds: number    // seconds between first and last message
  createdAt: string
}
```

**Prompt strategy:**
- Feed the full transcript (user + bond messages, skip tool meta noise)
- Cap at ~50 messages or ~15k tokens of transcript (truncate middle, keep first/last)
- Ask for structured JSON output
- Explicitly define the distinction: "A **decision** is something the user agreed to or concluded. An **open thread** is something discussed but not resolved — work that's still in progress."
- "keyFacts" captures durable things: "User prefers Tailwind over CSS modules", "Bond project uses Vue 3 + Electron"
- If the session is trivial (routine task, no decisions or threads), allow empty arrays — don't force extraction

**Output validation:**
- Parse JSON, validate all 5 fields exist and are correct types
- If malformed: retry once with a shorter prompt
- If retry fails: store degraded debrief (summary only, other fields empty)
- Log warnings for degraded debriefs so we can track quality

**Cost:** One Sonnet call per session archive. ~$0.01 per debrief.

### 1.2 Database Schema

New tables and FTS indexes in `db.ts`:

```sql
-- Session debriefs
CREATE TABLE IF NOT EXISTS sense_debriefs (
  id TEXT PRIMARY KEY,
  session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  session_title TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,

  summary TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  decisions TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  open_threads TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  key_facts TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings

  -- Flattened text for better FTS quality (no JSON brackets/quotes)
  topics_text TEXT NOT NULL DEFAULT '',
  decisions_text TEXT NOT NULL DEFAULT '',
  open_threads_text TEXT NOT NULL DEFAULT '',
  key_facts_text TEXT NOT NULL DEFAULT '',

  message_count INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sense_debriefs_created ON sense_debriefs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sense_debriefs_project ON sense_debriefs(project_id);

-- FTS5 for full-text search — uses flattened text columns, not raw JSON
CREATE VIRTUAL TABLE sense_debriefs_fts USING fts5(
  summary,
  topics_text,
  decisions_text,
  open_threads_text,
  key_facts_text,
  session_title,
  content=sense_debriefs,
  content_rowid=rowid
);

CREATE TRIGGER sense_debriefs_fts_insert AFTER INSERT ON sense_debriefs BEGIN
  INSERT INTO sense_debriefs_fts(rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
  VALUES (NEW.rowid, NEW.summary, NEW.topics_text, NEW.decisions_text, NEW.open_threads_text, NEW.key_facts_text, NEW.session_title);
END;

CREATE TRIGGER sense_debriefs_fts_delete AFTER DELETE ON sense_debriefs
  WHEN OLD.summary IS NOT NULL BEGIN
    INSERT INTO sense_debriefs_fts(sense_debriefs_fts, rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
    VALUES ('delete', OLD.rowid, OLD.summary, OLD.topics_text, OLD.decisions_text, OLD.open_threads_text, OLD.key_facts_text, OLD.session_title);
END;

CREATE TRIGGER sense_debriefs_fts_update AFTER UPDATE OF summary ON sense_debriefs BEGIN
  INSERT INTO sense_debriefs_fts(sense_debriefs_fts, rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
  VALUES ('delete', OLD.rowid, OLD.summary, OLD.topics_text, OLD.decisions_text, OLD.open_threads_text, OLD.key_facts_text, OLD.session_title);
  INSERT INTO sense_debriefs_fts(rowid, summary, topics_text, decisions_text, open_threads_text, key_facts_text, session_title)
  VALUES (NEW.rowid, NEW.summary, NEW.topics_text, NEW.decisions_text, NEW.open_threads_text, NEW.key_facts_text, NEW.session_title);
END;

-- Pinned facts (explicit "remember this" items)
CREATE TABLE IF NOT EXISTS sense_facts (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',      -- 'user' (explicit pin) or 'debrief' (promoted from keyFacts)
  source_debrief_id TEXT REFERENCES sense_debriefs(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,        -- 0 = superseded/corrected
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sense_facts_active ON sense_facts(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sense_facts_project ON sense_facts(project_id);
```

**Note on FTS5 + TEXT PRIMARY KEY:** The `content_rowid=rowid` pattern works because SQLite assigns implicit integer rowids to all tables (even with TEXT PKs). This is the same pattern used by `sense_captures` FTS. Joins go through rowid: `SELECT d.* FROM sense_debriefs_fts f JOIN sense_debriefs d ON d.rowid = f.rowid`.

**Note on _text columns:** The JSON arrays (`topics`, `decisions`, etc.) are stored as-is for programmatic access. The `_text` variants are flattened (space-separated, no brackets/quotes) for better FTS5 quality. Both are populated on insert by the CRUD module.

### 1.3 Trigger: Archive Hook

When a session is archived, generate a debrief. The archive completes immediately — the debrief generates in the background (same pattern as title generation).

**Hook location:** In `server.ts`, in the `session.update` handler. The current handler calls `updateSession(sid, updates)` directly — there is no "previousState" available. The simplest correct approach:

```typescript
case 'session.update': {
  const sid = getStringParam(p, 'id')
  const updates = getParam(p, 'updates') as Record<string, unknown> | undefined
  if (!sid) return ...

  const result = updateSession(sid, updates ?? {})

  // Trigger debrief on archive (idempotent — skips if debrief exists)
  if (updates?.archived === true) {
    generateDebriefIfNeeded(sid).catch((err) => {
      console.warn('[bond] debrief generation failed:', err.message)
    })
  }

  // Delete stale debrief on un-archive (session may be edited and re-archived)
  if (updates?.archived === false) {
    deleteDebriefBySession(sid)
  }

  return JSON.stringify(makeResponse(id, result))
}
```

**`generateDebriefIfNeeded`:**
1. Check if debrief already exists for this session → skip if so
2. Count substantive messages (role = 'user' or 'bond' with text) → skip if < 5
3. Generate debrief via Sonnet
4. Validate output, retry once if malformed
5. Store debrief with flattened _text fields

**Un-archive handling:** If a session is un-archived (archived = false), delete its existing debrief. This way, if the session is later re-archived after edits, a fresh debrief is generated. Prevents stale debriefs.

**Quick chat auto-archive:** `src/main/quick-chat.ts` archives via `client.updateSession(sid, { archived: true })`, which goes through the same `session.update` RPC handler. No separate hook needed.

### 1.4 Debrief CRUD (`src/daemon/debriefs.ts`)

```typescript
// Flatten JSON array to space-separated text for FTS
function flattenForFts(arr: string[]): string {
  return arr.join(' ')
}

export function createDebrief(debrief: SessionDebrief): SessionDebrief
export function getDebrief(id: string): SessionDebrief | null
export function getDebriefBySession(sessionId: string): SessionDebrief | null
export function deleteDebriefBySession(sessionId: string): boolean
export function listDebriefs(options?: {
  projectId?: string
  limit?: number
  since?: string
}): SessionDebrief[]
export function searchDebriefs(query: string, limit?: number): SessionDebrief[]

// For auto-injection — returns deduplicated open threads
export function getRecentOpenThreads(options?: {
  limit?: number
  projectId?: string           // prioritize project-specific threads
  excludeResolved?: boolean    // check against sense_facts for resolution
}): string[]

// For auto-injection — returns recent decisions with context
export function getRecentDecisions(options?: {
  limit?: number
  projectId?: string
}): { decision: string; sessionTitle: string; createdAt: string }[]
```

**Open thread deduplication:** `getRecentOpenThreads` must deduplicate. If the same thread appears in 3 consecutive debriefs, it should appear once in the injection. Strategy: pull threads from last N debriefs, normalize whitespace, deduplicate by substring similarity (exact match after lowercasing + trimming). If a thread was later mentioned in a decision (in a newer debrief), consider it resolved and exclude it.

---

## Phase 2: Auto-Injection into System Prompt

> Moved up from Phase 3. Both reviewers agreed: this is where the value is, ship it right after the debrief pipeline.

### 2.1 Chat Memory Context Block

Extend the existing auto-injection in `agent.ts` (currently ~line 450). After the screen context block, add a chat memory block. **Hard cap: 300 words.**

```typescript
// Chat memory auto-injection
if (senseSettings.chatMemoryInject) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Pinned facts — always loaded, highest priority
  const facts = getActiveFacts({ projectId: sessionProjectId, limit: 10 })

  // Open threads — deduplicated, project-scoped when possible
  const threadOpts = { limit: 5, projectId: sessionProjectId, excludeResolved: true }
  const openThreads = getRecentOpenThreads(threadOpts)

  // Recent decisions
  const decisions = getRecentDecisions({ limit: 5, projectId: sessionProjectId })

  // Latest debrief summary
  const latestDebrief = listDebriefs({ limit: 1, projectId: sessionProjectId })[0]
    ?? listDebriefs({ limit: 1 })[0]

  let memoryBlock = ''
  let wordCount = 0

  if (facts.length > 0) {
    memoryBlock += '\nKnown facts:\n'
    for (const f of facts) {
      memoryBlock += `- ${f.fact}\n`
      wordCount += f.fact.split(/\s+/).length + 1
    }
  }

  if (openThreads.length > 0 && wordCount < 250) {
    memoryBlock += 'Open threads:\n'
    for (const thread of openThreads) {
      if (wordCount > 250) break
      memoryBlock += `- ${thread}\n`
      wordCount += thread.split(/\s+/).length + 1
    }
  }

  if (decisions.length > 0 && wordCount < 280) {
    memoryBlock += 'Recent decisions:\n'
    for (const d of decisions) {
      if (wordCount > 280) break
      memoryBlock += `- ${d.decision} (${d.sessionTitle})\n`
      wordCount += d.decision.split(/\s+/).length + 3
    }
  }

  if (latestDebrief && wordCount < 300) {
    memoryBlock += `\nLast session: "${latestDebrief.sessionTitle}" — ${latestDebrief.summary}\n`
  }

  if (memoryBlock) {
    basePrompt += '\nRECENT MEMORY:\n' + memoryBlock
  }
}
```

### 2.2 Project-Scoped Memory

When a session is linked to a project, the auto-injection prioritizes debriefs and facts from that project. For unlinked sessions, only general (non-project) debriefs and facts are injected — avoids cross-project noise.

```typescript
if (sessionProjectId) {
  // Project-specific threads and decisions first
  // Then general (unlinked) threads if budget allows
} else {
  // Only general threads — don't inject project-specific context into unlinked chats
}
```

### 2.3 Settings

Add to `SenseSettings`:

```typescript
interface SenseSettings {
  // ... existing fields ...
  chatMemoryInject: boolean      // default: true
  chatMemoryWindowDays: number   // days to look back (default: 7)
}
```

Keep it simple. No `chatMemoryMaxTokens` setting — the 300-word cap is hardcoded. Users shouldn't need to tune injection size.

---

## Phase 3: Explicit Memory ("Bond, remember this")

> Flagged by product review as the #1 thing users expect from a memory system.

### 3.1 Overview

Users should be able to say "remember that the prod database is on port 5433" and have it stick. This goes into the `sense_facts` table and is always loaded into the system prompt (within the 300-word budget).

### 3.2 CLI

```
bond sense remember "prod database is on port 5433"        # Pin a fact
bond sense remember "prefer dark mode" --project Bond       # Project-scoped fact
bond sense facts                                             # List active facts
bond sense forget <id|number>                                # Deactivate a fact
```

### 3.3 RPC Methods

```
sense.remember    → createFact(fact, projectId?)
sense.facts       → listFacts({ active: true, projectId? })
sense.forget      → deactivateFact(id)
```

### 3.4 Agent Integration

Bond can also pin facts proactively during conversation. Add to the system prompt instructions:

```
When the user says "remember this" or "keep in mind that...", use `bond sense remember` to pin the fact.
You can also pin facts proactively when the user states a clear preference or convention.
```

### 3.5 Memory Corrections

When a user says "no, we decided against Redis" — Bond should:
1. Search existing facts and decisions for "Redis"
2. Deactivate the contradicting fact (`sense_facts.active = 0`)
3. Pin the corrected fact

This is manual for now. Automated contradiction detection (comparing new decisions against old ones) is a future enhancement — the data is there, but the heuristics are tricky.

---

## Phase 4: Search & CLI

### 4.1 CLI Commands

Flat structure. No nested subcommands. Bond's agent is the primary consumer; these need to be easy for an LLM to pick from, not organized like an admin console.

```
bond sense                              Status (all channels)
bond sense now                          Current screen context (existing)
bond sense today                        Today's summary (existing)
bond sense search <query>               Cross-channel search (see + chat)
bond sense apps [today|week]            App usage (existing)
bond sense timeline [range]             Chronological activity (existing)

bond sense memory                       Show recent debriefs + active facts
bond sense threads                      Open threads from recent sessions
bond sense decisions                    Recent decisions
bond sense debrief <session-id>         Full debrief detail
bond sense remember <fact>              Pin a fact
bond sense facts                        List active facts
bond sense forget <id>                  Deactivate a fact
bond sense backfill [--limit 50]        Generate debriefs for old sessions

bond sense on/off/pause/resume          Existing controls
bond sense config                       Existing settings
bond sense stats                        Existing storage stats
```

**Backward compatibility:** All existing `bond sense` commands continue to work unchanged. New commands are additive.

### 4.2 New RPC Methods

```
sense.memory         → { debriefs: listDebriefs({ limit: 5 }), facts: listFacts({ active: true }) }
sense.threads        → getRecentOpenThreads({ limit: 10 })
sense.decisions      → getRecentDecisions({ limit: 10 })
sense.debrief        → getDebrief(id) or getDebriefBySession(sessionId)
sense.remember       → createFact(fact, projectId?)
sense.facts          → listFacts({ active: true, projectId? })
sense.forget         → deactivateFact(id)
sense.search         → combined screen captures + debriefs FTS search (union, sort by date)
sense.backfill       → backfillDebriefs(limit)
```

### 4.3 Cross-Channel Search

`sense.search` queries both `sense_fts` (screen captures) and `sense_debriefs_fts` (debriefs). Returns a unified result list sorted by date. No attempt at cross-table relevance ranking — just recency. Each result has a `channel` field (`see` or `chat`) so the caller knows the source.

---

## Phase 5: Backfill Existing Sessions

### 5.1 Backfill Function

Generate debriefs for archived sessions that don't have one. Per-session error handling so one failure doesn't stop the batch.

```typescript
async function backfillDebriefs(limit = 50): Promise<{ generated: number; skipped: number; failed: number }> {
  const db = getDb()
  const sessions = db.prepare(`
    SELECT s.id, s.title, s.project_id
    FROM sessions s
    WHERE s.archived = 1
    AND s.id NOT IN (SELECT session_id FROM sense_debriefs WHERE session_id IS NOT NULL)
    AND (
      SELECT COUNT(*) FROM messages
      WHERE session_id = s.id AND role IN ('user', 'bond') AND text IS NOT NULL
    ) >= 5
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit)

  let generated = 0, skipped = 0, failed = 0

  for (const session of sessions) {
    try {
      await generateDebriefIfNeeded(session.id)
      generated++
    } catch (err) {
      console.warn(`[bond] backfill failed for session ${session.id}:`, err.message)
      failed++
    }
    // Rate limit — 2s between Sonnet calls
    await new Promise(r => setTimeout(r, 2000))
  }

  return { generated, skipped: sessions.length - generated - failed, failed }
}
```

**Cost:** ~50 sessions × $0.01 = ~$0.50 via Sonnet. Negligible.

### 5.2 CLI

```
bond sense backfill              # Default: last 50 archived sessions
bond sense backfill --limit 100  # More
```

Outputs progress: `Generated 47 debriefs, skipped 2, failed 1`

---

## Phase 6: UI (Future)

### 6.1 Sense View Enhancement

The existing `SenseView.vue` shows screen capture timelines. Add a second tab or mode for chat memory:

- **Memory tab:** Debrief cards in chronological order, pinned facts at the top
- **Search:** Unified results showing screen captures and chat debriefs
- **Debrief detail:** Expandable card showing summary, decisions, open threads, key facts
- **Thread tracker:** Dedicated view showing all open threads with resolve/dismiss actions

This is the largest UI effort and can be deferred. The CLI + auto-injection delivers most of the value without any UI changes.

### 6.2 Session Archive UX

When archiving a session, show a subtle indicator that a debrief is being generated (similar to the title generation spinner).

---

## Deferred: Browse & Clipboard Channels

These channels are designed and ready to build when the core memory system is proven. They follow the same pattern: table + FTS + recording hook + CLI subcommands.

### Browse Channel (deferred)

Record browsing activity from Bond's built-in browser. Event-driven via existing `did-navigate` events in `BrowserView.vue`.

**Important implementation note (from architecture review):** The plan originally proposed calling `window.bond.senseBrowse()` — but BrowserView.vue uses `window.bond.browser.*` (a structured namespace registered via preload/contextBridge). Adding browse recording requires the full renderer→preload→main→daemon IPC pipeline, not a one-liner. Specifically:
1. New method in preload's `contextBridge.exposeInMainWorld`
2. New IPC handler in main process
3. Forward to daemon via RPC
4. New RPC handler in `server.ts`

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS sense_browse (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  favicon TEXT,
  tab_id TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sense_browse_created ON sense_browse(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sense_browse_domain ON sense_browse(domain);
CREATE INDEX IF NOT EXISTS idx_sense_browse_tab ON sense_browse(tab_id, created_at DESC);
```

**Scope cuts (per reviews):** No duration tracking in v1. No content scraping. Just URL + title + domain + timestamp.

### Clipboard Channel (deferred)

Store clipboard contents as searchable records. The clipboard monitor in `sense/clipboard.ts` already detects changes.

**Privacy posture:** `clipboardSenseEnabled` defaults to **false** (opt-in). Clipboard content passes through the existing redaction engine but cannot catch everything (raw passwords from password managers, personal messages). Users must explicitly enable.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS sense_clipboard (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,             -- SHA-256 of original content for dedup
  content_length INTEGER NOT NULL,
  source_app TEXT,
  source_bundle_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sense_clipboard_created ON sense_clipboard(created_at DESC);
```

**Scope cuts (per reviews):** No content type detection in v1 (except URL detection, which is reliable). No source_window_title (unnecessary). Content truncated to 2000 chars. 30-day retention.

---

## Implementation Order

| Step | What | Files | Effort |
|------|------|-------|--------|
| 1 | DB migration: `sense_debriefs` + `sense_facts` tables + FTS | `db.ts` | Small |
| 2 | Debrief generator module (Sonnet, with validation + retry) | `generate-debrief.ts` (new) | Medium |
| 3 | Debrief + Facts CRUD module | `debriefs.ts` (new) | Medium |
| 4 | Archive hook in server (with un-archive cleanup) | `server.ts` | Small |
| 5 | **Auto-injection into system prompt** | `agent.ts` | Medium |
| 6 | RPC methods for memory queries | `server.ts` | Small |
| 7 | CLI: flat memory commands | `sense.ts` | Medium |
| 8 | Backfill command | `debriefs.ts`, `sense.ts` | Small |
| 9 | Settings additions | `shared/sense.ts` | Small |

**Build order:**
1. Steps 1-5: The core loop. Debriefs generate on archive, inject into system prompt. **This is when Bond gets memory.** Validate that open threads and decisions actually make conversations feel continuous before building anything else.
2. Steps 6-7: Wire up CLI and RPC so Bond can search its own memory and the user can manage facts.
3. Steps 8-9: Backfill old sessions, polish settings.

**Estimated total: 2-3 focused sessions.**

Browse and clipboard channels can be added later in 1-2 additional sessions each, following the deferred specs above.

---

## Design Principles

1. **Sense is the memory.** No separate MEMORY.md. No special files. The database is the source of truth.

2. **Debriefs are the atomic unit.** Every substantive session produces one. They're structured, searchable, and composable.

3. **Working memory is auto-generated.** No manual curation required. The system prompt gets recent context automatically.

4. **But users can pin facts explicitly.** "Bond, remember this" writes to `sense_facts`. This is the most intuitive memory interaction and should work from day one.

5. **The user doesn't have to think about it.** Archive a session → debrief happens. Start a new session → context is there. The plumbing is invisible.

6. **Keep injection small.** Hard cap at 300 words. Prioritize signal over completeness. Better to inject 5 high-value lines than 20 lines of noise.

7. **Channels are extensible.** Adding browse, clipboard, or code later follows the same pattern: table → FTS → recording hook → CLI → optional injection.

8. **Memory is inspectable and correctable.** Users can see what Bond remembers (`sense facts`, `sense memory`), correct mistakes (`sense forget`), and pin new facts (`sense remember`). Transparent, not a black box.

---

## Resolved Questions (from reviews)

- **Debrief generation: async.** Archive completes immediately, debrief generates in background. Non-blocking.

- **Open thread deduplication: yes.** Normalize, deduplicate by substring match, exclude threads that appear in later decisions (implying resolution).

- **Un-archive handling: delete stale debrief.** If a session is un-archived, its debrief is deleted. Re-archiving generates a fresh one.

- **Retention for debriefs: keep forever.** They're tiny (~1-2KB each). Even 10,000 debriefs = ~20MB with FTS. No retention pressure.

- **Haiku vs Sonnet: Sonnet.** Quality gap is significant for judgment-heavy extraction. Cost gap is negligible.

- **Backfill error handling: per-session try/catch.** One failure doesn't stop the batch.

- **clipboardSenseEnabled default: false.** Opt-in for privacy.

## Open Questions

- **Thread decay:** Should open threads older than N days auto-fade from injection even if not explicitly resolved? Probably yes — a 2-week-old unresolved thread is likely stale. Start with 14-day decay, adjust based on experience.

- **Proactive fact pinning by Bond:** Should Bond autonomously pin facts it notices ("you seem to prefer dark mode")? Deferred — let users drive pinning first, add autonomous pinning when we understand the quality bar.

- **Contradiction detection:** Automated detection of conflicting decisions across debriefs. The data is there (all decisions are searchable), but the heuristics are tricky. Defer until the manual correction flow is proven.

- **Code channel:** Blocked on scheduler infrastructure. Git hooks (post-commit → write to sense DB) are an alternative that needs no scheduler but requires per-repo setup. Could ship `bond sense code init` to install hooks. Deferred.
