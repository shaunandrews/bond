# Sense — Ambient Screen Awareness

Always-on screen context built natively into Bond. Periodic screenshots, OCR, window detection, accessibility tree extraction, and structured indexing — giving Bond passive awareness of what the user is doing without being told.

---

## Why

Bond is good at what it's asked to do. But every conversation starts cold — the user has to explain what they're working on, what they were just looking at, what app they're in. That friction adds up.

Sense closes that gap. Bond sees what's on screen, knows which app is active, reads visible text, and indexes it all locally. The user opens Bond and it already has context. "That thing I was just looking at" becomes a real query. Daily summaries, time tracking, recall, and proactive suggestions all become possible without any manual input.

This is a first-party replacement for [Familiar](https://github.com/familiar-software/familiar) (MIT-licensed), an Electron app that does the same thing as a standalone tool. Building it into Bond eliminates the second app, removes the skill middleware layer, and enables tighter integration with projects, todos, journal, and conversations.

---

## Research Findings

Before building, we surveyed the landscape of ambient AI awareness tools:

### Familiar (MIT, the foundation)
Electron menu bar app. Captures screenshots every 5s via `desktopCapturer`, OCR via Apple Vision native helper, clipboard mirroring every 500ms. Writes structured markdown files (YAML frontmatter + OCR text) to disk. Installs SKILL.md files into AI agent skill directories so Claude Code / Codex / Cursor can read the data. No AI of its own — purely a capture + storage layer. Pre/post window detection discards ambiguous frames. Redaction via bundled ripgrep. ~1GB per 2 months of continuous use. Our plan ports its core pipeline.

### Rewind AI (acquired → Limitless → Meta)
ScreenCaptureKit at 0.5 Hz, H.264 video encoding, Apple Vision OCR, SQLite FTS4. **Cautionary tale on resource usage**: 20% baseline CPU, 200%+ encoding spikes, 20-40% battery reduction. Their continuous video encoding approach was a resource disaster — validates our screenshot-based approach. Pivoted to audio-only hardware pendant before Meta acquisition killed the product.

### Windows Recall
Most security-hardened approach: VBS Enclaves with TPM-bound per-snapshot encryption, 40+ TOPS NPU for local AI processing, Microsoft Purview for sensitive content detection. Ships **off by default**. Key insight: OS-level integration gives access that third-party apps can't match. Their `SetWindowDisplayAffinity` API lets apps opt out of capture.

### Screenpipe (Rust/Tauri, $2.8M funded)
**The most architecturally interesting project.** Three key innovations worth adopting:

1. **Accessibility tree as primary text source** — reads macOS `AXUIElement` tree instead of OCR for native apps. ~80% reduction in CPU vs. pure OCR. Structured data (labeled elements, hierarchy) is richer than raw OCR text. Falls back to OCR only for non-native content (Electron custom renders, remote desktops, games).

2. **Event-driven capture** — app switch, click/scroll, typing pause, clipboard change, idle timer. Only captures when something meaningful happens. Result: ~5-10% CPU, ~300 MB/8hr vs. ~2 GB continuous.

3. **Three-layer permission model** for data access: skill gating (tools removed before execution), runtime interception (Rust-level blocking), server middleware (cryptographic tokens per pipe). Prompt-level restrictions alone are insufficient.

MCP server on localhost with four read-only tools (`queryScreenpipe`, `getRecentContext`, `searchRecent`, `getMeetingTranscripts`). This is the direction for external AI tool integration.

### Other Projects
- **macOSpilot**: Simplest approach — screenshot-on-hotkey sent to Vision API. Sometimes "what's on screen right now" as a single snapshot is all you need.
- **OpenAdapt**: Process automation angle. Records mouse/keyboard at 100 Hz + screenshots + accessibility tree simultaneously. Policy/Grounding separation pattern.
- **MacPaw macapptree**: Python package extracting macOS accessibility tree in JSON with bounding boxes. Reference implementation for AXUIElement walking.

### Key Patterns Across All Projects
1. **Local-only processing is non-negotiable** — OCR, indexing, search all on-device
2. **Don't dump raw OCR into AI context** — synthesize and summarize
3. **Double-check blacklist** (pre+post capture) is the standard pattern
4. **Accessibility tree > OCR** when available (cheaper, richer, more accurate)
5. **Event-driven > fixed interval** for both quality and resources
6. **Screenshot stills > video encoding** — video is a resource disaster

---

## Architecture

### Two Tiers of Awareness

**Tier 0: Metadata-only (no Screen Recording permission)**
Works immediately with zero setup. Captures:
- Active app name + window title (via `CGWindowListCopyWindowInfo` — no special permission)
- Clipboard text changes
- File system events in known project paths (via FSEvents)
- Git status of active projects

This gives Bond: "Shaun is in Figma working on 'Connectors — Drafts', was previously in VS Code editing `src/renderer/App.vue` on the `feature/sense` branch, and just copied a hex color to clipboard" — without any screenshots or OCR.

**Tier 1: Full capture (Screen Recording permission granted)**
Everything in Tier 0, plus:
- Screenshot capture (WebP, 0.5x scale)
- Accessibility tree extraction (primary text source)
- OCR via Apple Vision (fallback for non-native apps)
- Structured markdown files with full context
- FTS5 full-text search across all captured text

Tier 0 runs by default. When the user enables full Sense, Bond requests Screen Recording permission and upgrades to Tier 1. The system degrades gracefully — if permission is revoked, it falls back to Tier 0 without losing metadata capture.

### Core Pipeline

```
[Tier 0: Always running]
Active Window Detection (CGWindowListCopyWindowInfo)
    → App name, window title, bundle ID
    → Indexed in SQLite

Clipboard Monitor (poll every 500ms)
    → Text saved with timestamp
    → Indexed in SQLite

[Tier 1: Screen Recording permission]
Screen Capture (Electron desktopCapturer)
    → Image saved to session folder
    → Accessibility tree extraction (AXUIElement, primary)
    → OCR extraction (Apple Vision, fallback)
    → Security redaction (regex-based)
    → Structured markdown written to disk
    → Indexed in SQLite with FTS5
```

### Capture Triggers (Hybrid: Event-Driven + Interval)

Instead of fixed-interval-only capture, Sense uses a hybrid approach from v1:

**Event-driven triggers** (capture immediately):
- App/window focus change (`NSWorkspace.frontmostApplication` KVO)
- Significant clipboard change (>1 word, different from last)

**Interval baseline** (configurable, default 5s):
- Runs between event-driven captures
- Ensures continuous coverage during sustained work in one app
- Drops to 15s on battery / low power mode

The event-driven triggers catch context transitions — the most valuable moments — while the interval fills in the gaps. This is more efficient than pure interval and produces better data at app boundaries.

### Components

| Component | What it does | Implementation |
|-----------|-------------|----------------|
| **Presence monitor** | Detects user active/idle/locked/suspended via `powerMonitor.getSystemIdleTime()`. Recording only runs when active. | Pure Electron API, no native code needed |
| **Screen recorder** | Captures screenshots from the display under the cursor using `desktopCapturer.getSources()`. Hidden BrowserWindow renders the capture. | Electron API. Follows cursor across displays. Saves WebP at 0.5x scale. |
| **Window detector** | Identifies the active app, window title, bundle ID, and all visible windows. Runs before AND after each capture to reject ambiguous frames where focus changed mid-capture. | Native binary (Objective-C). Uses `CGWindowListCopyWindowInfo` + NSWorkspace. Shipped in app resources. |
| **Accessibility extractor** | Walks the AXUIElement tree for the focused app to extract structured text content — labels, headings, text fields, values. Primary text source for native apps. | Native binary (Objective-C). Uses Accessibility API (`AXUIElementCopyAttributeValue`). Requires Accessibility permission (optional — degrades to OCR-only without it). |
| **OCR extractor** | Extracts text lines from screenshots using Apple Vision framework (`VNRecognizeTextRequest`). Fallback for apps where accessibility tree is sparse. | Native binary (Objective-C). Runs in batches, max 2 parallel processes to limit CPU. |
| **Text source router** | Decides whether to use accessibility tree, OCR, or both for a given capture. Learns which apps have good accessibility data vs. needing OCR. | JS. Simple heuristic: try accessibility first, if <20 characters extracted, queue OCR. |
| **Redaction engine** | Scans extracted text for passwords, API keys, card numbers, secrets. Redacts or drops entire frames containing payment info. | Pure JS regex. No bundled ripgrep — unnecessary dependency for pattern matching. |
| **Markdown writer** | Combines text + window metadata into structured YAML-frontmatter markdown files. One file per capture. | JS. Same format as Familiar for backward compatibility during transition. |
| **Indexer** | Inserts capture metadata + text into SQLite for fast querying. Full-text search via FTS5. | SQLite. Runs inline with markdown writer. |
| **Capture privacy** | App blacklist — never capture when blacklisted apps are visible (banking, password managers, etc.). User-configurable. | JS. Checks visible window names against blacklist before and after capture. |
| **Clipboard mirror** | Polls clipboard every 500ms, saves text content when it changes. Skips single-word entries (too noisy). | JS. Runs in both Tier 0 and Tier 1. |
| **App-switch observer** | Detects frontmost application changes via NSWorkspace KVO. Fires immediate capture trigger. | Native — could extend `bond-window-helper` or use Electron's `app.on('browser-window-focus')` + polling. |

### Capture Lifecycle

1. Presence monitor emits `active` → controller transitions to `recording` state
2. On each capture trigger (event-driven or interval):
   - Detect visible windows (pre-capture snapshot)
   - Check blacklist — skip if sensitive app visible
   - [Tier 1] Capture screenshot via hidden BrowserWindow + desktopCapturer
   - Detect visible windows again (post-capture snapshot)
   - Check blacklist again — discard frame if sensitive app appeared
   - Compare pre/post snapshots — if active window changed mid-capture, record as ambiguous
   - [Tier 1] Save image to session folder
   - [Tier 1] Route to text extraction (accessibility tree → OCR fallback)
   - [Tier 0] Record metadata event (app, title, timestamp)
3. [Tier 1] Text extraction worker processes queue:
   - Try accessibility tree first for focused app
   - If sparse (<20 chars), queue OCR
   - Extracted text → redaction scan → markdown file + SQLite index
4. Presence monitor emits `idle` → controller stops recording, closes session
5. Lock/suspend → immediate stop

---

## Data Model

### Database tables

```sql
-- Capture sessions (one per active period)
CREATE TABLE sense_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  capture_count INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'metadata',  -- 'metadata' | 'full'
  created_at TEXT NOT NULL
);

-- Individual captures (Tier 1 — full captures with images)
CREATE TABLE sense_captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sense_sessions(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  image_path TEXT NOT NULL,
  markdown_path TEXT,
  app_name TEXT,
  app_bundle_id TEXT,
  window_title TEXT,
  visible_windows TEXT DEFAULT '[]',   -- JSON array
  text_source TEXT DEFAULT 'pending',  -- pending | accessibility | ocr | both | failed
  ocr_status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | skipped | failed
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sense_captures_session ON sense_captures(session_id);
CREATE INDEX idx_sense_captures_time ON sense_captures(captured_at DESC);
CREATE INDEX idx_sense_captures_app ON sense_captures(app_name);
CREATE INDEX idx_sense_captures_status ON sense_captures(ocr_status);

-- Metadata events (Tier 0 — lightweight app/window tracking)
CREATE TABLE sense_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sense_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- 'app_switch' | 'window_focus' | 'clipboard' | 'file_change'
  timestamp TEXT NOT NULL,
  app_name TEXT,
  app_bundle_id TEXT,
  window_title TEXT,
  data TEXT,                 -- JSON blob for event-specific data (clipboard text, file path, etc.)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sense_events_session ON sense_events(session_id);
CREATE INDEX idx_sense_events_time ON sense_events(timestamp DESC);
CREATE INDEX idx_sense_events_type ON sense_events(event_type);
CREATE INDEX idx_sense_events_app ON sense_events(app_name);

-- Full-text search on OCR/accessibility content
CREATE VIRTUAL TABLE sense_fts USING fts5(
  capture_id,
  ocr_text,
  app_name,
  window_title,
  content=sense_captures,
  content_rowid=rowid
);
```

### File storage

```
~/Library/Application Support/bond/sense/
  stills/
    session-2026-04-04T10-30-00/
      2026-04-04T10-30-00.webp
      2026-04-04T10-30-05.webp
      ...
  markdown/
    session-2026-04-04T10-30-00/
      2026-04-04T10-30-00.md
      2026-04-04T10-30-05.md
      ...
  clipboard/
    session-2026-04-04T10-30-00/
      2026-04-04T10-30-12.clipboard.txt
```

### Markdown format

```yaml
---
format: bond-sense-v1
text_source: accessibility         # accessibility | ocr | both
source_image: 2026-04-04T10-30-00.webp
screen_resolution: 3024x1964
app: Figma
app_bundle_id: com.figma.Desktop
window_title_raw: Connectors — Drafts
window_title_norm: Connectors — Drafts
visible_windows:
  - "Figma"
  - "Slack"
  - "Arc"
capture_trigger: app_switch        # app_switch | interval | clipboard
---
# Text Content
- "Connectors redesign v3"
- "Status: Draft"
- "Last edited 2 hours ago"
```

Format is `bond-sense-v1` (not Familiar's `familiar-layout-v0`) since we're adding `text_source` and `capture_trigger` fields.

### Storage management

- **Tiered retention**: Full fidelity (images + markdown) for 14 days. After that, images are deleted but markdown + index retained for 90 days. After 90 days, everything purged. Metadata events (Tier 0) retained for 90 days.
- **Storage cap**: Auto-cleanup when sense data exceeds configurable limit (default 2GB). Oldest sessions purged first.
- **Manual purge**: User can clear all data or a specific date range.

**Expected storage**: ~300 MB per 8-hour workday with hybrid capture (vs. ~2 GB with continuous fixed-interval). Event-driven triggers reduce capture count significantly while improving data quality at transition points.

---

## Native Helpers

Three Objective-C binaries, compiled and shipped in Bond's app resources.

### 1. `bond-ocr-helper`

Wraps Apple Vision framework's `VNRecognizeTextRequest`.

**Input**: image path, recognition level (accurate/fast), language hints, min confidence
**Output**: JSON with `meta` (image dimensions, languages, confidence) and `lines` (array of recognized text strings)

```bash
bond-ocr-helper --image /path/to/capture.webp --level accurate --min-confidence 0.0
# → { "meta": { "image_width": 1512, ... }, "lines": ["text line 1", "text line 2"] }
```

Port from Familiar's `familiar-ocr-helper`. Straightforward Apple Vision API wrapper, ~200 lines of Obj-C.

### 2. `bond-window-helper`

Lists visible on-screen windows with app name, bundle ID, title, PID, and active state.

**Input**: minimum visible area threshold (to filter tiny/hidden windows)
**Output**: JSON array of window objects

```bash
bond-window-helper --json --min-visible-area 3000
# → [{"name":"Figma","bundleId":"com.figma.Desktop","title":"Connectors","active":true,"pid":1234}]
```

Uses `CGWindowListCopyWindowInfo` with `kCGWindowListOptionOnScreenOnly`. Port from Familiar's `list-on-screen-apps-helper`.

### 3. `bond-accessibility-helper`

Walks the AXUIElement tree for a given PID and extracts text content.

**Input**: PID of target app, max depth, element types to include
**Output**: JSON with structured text content

```bash
bond-accessibility-helper --pid 1234 --max-depth 10 --types text,label,heading,value
# → { "app": "Figma", "elements": [
#     {"type": "heading", "value": "Connectors — Drafts", "depth": 0},
#     {"type": "text", "value": "Status: Draft", "depth": 2},
#     ...
#   ]}
```

New binary. Uses `AXUIElementCopyAttributeValue` to walk the element tree. Requires Accessibility permission (System Settings → Privacy & Security → Accessibility). Reference: MacPaw's [macapptree](https://github.com/MacPaw/macapptree) for the AXUIElement walking pattern.

**Note**: Accessibility permission is separate from Screen Recording. Many users already grant it for tools like Rectangle, BetterTouchTool, etc. If not granted, Sense falls back to OCR-only (no degradation in capture, just different text extraction path).

### Build process

All helpers are compiled via shell scripts during Bond's build step:

```bash
# scripts/build-native-helpers.sh
xcrun clang -framework Foundation -framework Vision -o resources/bond-ocr-helper src/native/ocr-helper.m
xcrun clang -framework Foundation -framework AppKit -framework CoreGraphics -o resources/bond-window-helper src/native/window-helper.m
xcrun clang -framework Foundation -framework AppKit -framework ApplicationServices -o resources/bond-accessibility-helper src/native/accessibility-helper.m
```

Binaries ship in `resources/` inside the Electron app bundle.

---

## Privacy & Security

### Permissions required

- **Screen Recording**: macOS system permission. Required for Tier 1 (screenshot capture). Without it, Sense runs in Tier 0 (metadata-only). `desktopCapturer` returns blank frames without this.
- **Accessibility** (optional but recommended): For accessibility tree text extraction. Without it, OCR is the only text source. Many users already grant this for other tools.

### Permission flow

On first enable, Bond checks permissions and guides the user:
1. Check `systemPreferences.getMediaAccessStatus('screen')`
2. If not granted, explain what Sense does at each tier:
   - Tier 0 (current): Bond knows which app you're in and what you copy
   - Tier 1 (with permission): Bond can read your screen and search your history
3. Open System Settings to the right pane via `shell.openExternal('x-apple.systempreferences:...')`
4. Poll permission status until granted, then upgrade to Tier 1
5. Optionally request Accessibility permission for richer text extraction

### App blacklist

Default blacklist (user can add/remove):
- 1Password, Bitwarden, LastPass, KeePassXC
- Keychain Access
- Banking apps (detected by bundle ID patterns)
- Private/incognito browser windows (detected by window title)

Blacklist check runs twice per capture — before AND after — to catch apps that appear mid-capture. If any blacklisted app is visible in either snapshot, the frame is discarded entirely (image deleted, nothing indexed).

**Blacklist applies to both tiers** — metadata events for blacklisted apps are also suppressed (no app name, no window title recorded).

### Redaction

Regex-based scanning of extracted text before writing to disk:
- API keys (AWS, GitHub, Stripe, OpenAI, Anthropic, Google, Slack, SendGrid, Twilio) → replaced with `[REDACTED_API_KEY]`
- Bearer tokens, JWTs → `[REDACTED_TOKEN]`
- Passwords in plaintext (common patterns like `password: ...`, `api_key=...`, `secret=...`) → `[REDACTED]`
- URLs with embedded credentials (`https://user:pass@host`) → credentials stripped
- Credit card numbers (Luhn-valid 13-19 digit sequences) + payment keywords → **entire frame dropped** (not just redacted)
- SSN patterns → `[REDACTED_SSN]`

### Data locality

All data stays on disk. Never sent to any server. OCR and accessibility extraction run locally. The only time capture data leaves the machine is when the user explicitly asks Bond to analyze it in conversation (at which point it's sent to the AI provider as conversation context, same as any other user-provided content).

### Recording indicator

Menu bar tray icon changes state when Sense is actively recording. Not hidden — the user should always know when captures are happening. Matches macOS conventions for screen recording indicators.

---

## CLI

```
bond sense                          Status — running, paused, last capture time, storage used
bond sense on                       Enable Sense (starts on next active period)
bond sense off                      Disable Sense (stops immediately)
bond sense pause [minutes]          Pause for N minutes (default 10)
bond sense resume                   Resume from pause

bond sense now                      Current screen context — last capture, active app, OCR text
bond sense today                    Summary of today — apps used, time distribution, activity timeline
bond sense yesterday                Same for yesterday
bond sense week                     Weekly summary

bond sense search <query>           Full-text search across all captured text
bond sense apps [today|week|all]    App usage breakdown with time estimates
bond sense timeline [range]         Chronological activity feed

bond sense exclude <app>            Add app to blacklist
bond sense include <app>            Remove app from blacklist
bond sense excluded                 List blacklisted apps

bond sense clear [range]            Delete capture data (today, week, all, or date range)
bond sense stats                    Storage usage, capture count, session count
bond sense config                   Show current settings (interval, retention, storage cap)
bond sense config <key> <value>     Update setting
```

### Implementation

**File:** `src/cli/sense.ts`

Same pattern as other CLI modules — WebSocket connect to daemon, JSON-RPC calls, formatted ANSI output.

**`bin/bond` addition:**

```bash
cmd_sense() {
  _ensure_cli
  node "$PROJECT_DIR/out/cli/sense.js" "$@"
}

# In case statement:
sense) shift; cmd_sense "$@" ;;
```

---

## Chat Integration

### Automatic context injection

When the user sends a message, Bond can optionally include recent screen context in the system prompt. This is NOT the full OCR dump — it's a compressed summary:

```
RECENT SCREEN CONTEXT (last 5 minutes):
- Active app: Figma (Connectors — Drafts)
- Previously: Slack (#design channel), Arc (GitHub PR #75934)
- Key visible text: "Connectors redesign v3", "DataViews vs expandable cards"
```

This is lightweight enough to include without ballooning token usage. The agent can request deeper context (full text, specific time ranges) by using `bond sense search` or `bond sense timeline` commands.

**Configuration**: Auto-context injection is opt-in. Settings toggle: "Include recent screen context in conversations." Default: off until the user enables it.

**Tier 0 context** (metadata-only) is even lighter:
```
RECENT ACTIVITY (last 5 minutes):
- Active app: Figma (Connectors — Drafts)
- Previously: VS Code (App.vue — bond), Slack
- Clipboard: "#7a5c3b"
```

Still useful — Bond knows what app you're in and what you recently copied, without needing Screen Recording permission.

### Conversational queries

The AI uses `bond sense` CLI commands to answer questions about screen history:

- "What was I looking at before this?" → `bond sense now` + recent captures
- "How much time did I spend in Figma today?" → `bond sense apps today`
- "When did I last see that Slack message from Jay?" → `bond sense search "Jay"`
- "Summarize my morning" → `bond sense timeline 9am-12pm` → AI synthesizes

### Project auto-detection

When Sense captures show activity in a known project path (e.g., VS Code editing files in `~/Developer/Projects/wp-core-connectors/`), Bond can:
- Auto-link the current chat to that project
- Surface relevant todos and journal entries
- Track time against the project automatically

This requires mapping project resource paths to detected file paths in window titles / URLs.

---

## Integration with Bond Features

### Todos

- "Add a todo for that thing I was just looking at" — Bond reads recent screen context and creates a todo with relevant details
- Auto-suggest todos based on patterns (e.g., seeing a TODO comment in code, a Slack message asking for something)

### Journal

- `bond journal add --from-sense` — Auto-generate a journal entry summarizing recent screen activity
- End-of-day summaries: Bond drafts a journal entry from the day's Sense data
- Attach screen context to journal entries for richer recall

### Projects

- Auto-detect which project the user is working on based on active files/URLs
- Time tracking per project: "How much time did I spend on connectors this week?" — answered from Sense data
- Project activity feed: show recent Sense captures relevant to a project

### Collections

- Browsing Letterboxd/IMDb/Goodreads → Bond notices and offers to add items to relevant collections
- "Add whatever movie I was just looking at to my watchlist" → OCR the title from recent captures

---

## Settings

Stored in daemon settings (same mechanism as existing Bond settings).

```ts
interface SenseSettings {
  enabled: boolean                    // master toggle, default false
  tier: 'metadata' | 'full'          // auto-detected from permissions, user can downgrade
  captureIntervalSeconds: number      // default 5
  lowPowerIntervalSeconds: number     // default 15
  idleThresholdSeconds: number        // default 60
  eventDrivenCapture: boolean         // capture on app switch, default true
  retentionDays: number               // full fidelity, default 14
  summaryRetentionDays: number        // markdown only (no images), default 90
  storageCapMb: number                // auto-cleanup threshold, default 2048
  blacklistedApps: string[]           // app names to never capture
  autoContextInChat: boolean          // inject recent context into conversations, default false
  clipboardCapture: boolean           // mirror clipboard contents, default true
  textExtractionPreference: 'auto' | 'accessibility' | 'ocr'  // default 'auto' (accessibility first, OCR fallback)
}
```

### Settings UI

Add a "Sense" section to Bond's settings panel:
- Master toggle with permission status indicator (showing Tier 0 / Tier 1 status)
- Capture interval slider
- Event-driven capture toggle
- Text extraction preference (Auto / Accessibility only / OCR only)
- Blacklisted apps list (add/remove)
- Storage usage display with clear button
- Retention period selector
- Auto-context toggle

---

## Implementation Plan

### Phase 1: Tier 0 — Metadata Awareness (no native code, no permissions)

Ship basic awareness fast. This requires zero native helpers and zero macOS permissions.

1. **`src/shared/session.ts`** — Add `SenseSession`, `SenseEvent`, `SenseSettings` types
2. **`src/daemon/db.ts`** — Add `migrateCreateSenseTables()` migration (sessions, events)
3. **`src/daemon/sense/presence.ts`** — Presence monitor (active/idle/lock/suspend via `powerMonitor`)
4. **`src/daemon/sense/metadata.ts`** — Window title + app name polling via Electron's built-in APIs (`BrowserWindow.getFocusedWindow()` for basic info, or shell out to `osascript` for frontmost app as an interim step before native helpers)
5. **`src/daemon/sense/clipboard.ts`** — Clipboard mirroring (port from Familiar)
6. **`src/daemon/sense/controller.ts`** — State machine: disabled → armed → recording → idle
7. **`src/daemon/server.ts`** — Register core Sense RPC methods (`sense.status`, `sense.enable`, `sense.disable`, `sense.now`, `sense.events`)
8. **`src/daemon/agent.ts`** — System prompt injection with recent activity context (Tier 0 format)

**Result**: Bond knows what app you're in, what you recently copied, when you switched apps. No screenshots, no OCR, no permissions needed.

### Phase 2: Native Helpers

1. **`src/native/window-helper.m`** — Port Familiar's CGWindowList helper (replaces interim `osascript` approach)
2. **`src/native/ocr-helper.m`** — Port Familiar's Apple Vision OCR wrapper
3. **`src/native/accessibility-helper.m`** — New: AXUIElement tree walker for structured text extraction
4. **`scripts/build-native-helpers.sh`** — Compile script for all three binaries
5. **Update `package.json`** — Add `build:native` script, integrate into build pipeline

### Phase 3: Tier 1 — Full Capture Pipeline

1. **`src/daemon/db.ts`** — Add `sense_captures` table + FTS5 migration
2. **`src/daemon/sense/recorder.ts`** — Screen capture recorder (hidden BrowserWindow + desktopCapturer)
3. **`src/daemon/sense/window-detector.ts`** — Wrapper around `bond-window-helper` binary (pre/post capture)
4. **`src/daemon/sense/accessibility.ts`** — Wrapper around `bond-accessibility-helper` binary
5. **`src/daemon/sense/ocr.ts`** — Wrapper around `bond-ocr-helper` binary + batch processing
6. **`src/daemon/sense/text-router.ts`** — Decides accessibility vs. OCR per capture (try accessibility first, queue OCR if sparse)
7. **`src/daemon/sense/redaction.ts`** — Regex-based security redaction
8. **`src/daemon/sense/markdown.ts`** — Markdown generation from text + metadata
9. **`src/daemon/sense/worker.ts`** — Queue-based text extraction worker (polls pending captures, processes batches)
10. **`src/daemon/sense/indexer.ts`** — SQLite indexing + FTS5 population
11. **`src/daemon/sense/storage.ts`** — Retention enforcement, auto-cleanup, storage stats
12. **`src/daemon/sense/privacy.ts`** — Blacklist checking, capture privacy logic
13. **Update controller.ts** — Add Tier 1 capture flow, event-driven triggers, permission checks

### Phase 4: IPC + Preload + CLI

**`src/main/index.ts`** — `ipcMain.handle('sense:*')` proxies
**`src/preload/index.ts`** — `window.bond.sense*` methods
**`src/cli/sense.ts`** — Full CLI implementation with all subcommands
**`bin/bond`** — Add `sense` command dispatch
**`package.json`** — Add to `build:cli` esbuild targets

Follows the same IPC bridge pattern as todos, projects, journal, and collections.

### Phase 5: Agent Integration

**`src/daemon/agent.ts`** — System prompt additions:

```
SENSE — SCREEN AWARENESS:
Bond has built-in screen awareness that captures what the user sees.
- `bond sense now` — current screen context
- `bond sense today` / `bond sense yesterday` — daily summaries
- `bond sense search <query>` — find when the user saw something specific
- `bond sense apps [today|week]` — app usage breakdown
- `bond sense timeline [range]` — chronological activity

Use Sense data when the user references past activity, needs work summaries,
wants to recall something they saw, or when context would help you give
better answers. Don't dump raw OCR — synthesize and summarize.
```

Upgrade from Tier 0 context injection to full Tier 1 context (includes key visible text, not just app names).

### Phase 6: Server RPC (complete set)

**`src/daemon/server.ts`** — Register remaining Sense RPC methods:

| Method | Params | Returns |
|--------|--------|---------|
| `sense.status` | — | `{ enabled, tier, state, lastCapture, sessionCount, storageBytes }` |
| `sense.enable` | — | `{ ok, tier }` |
| `sense.disable` | — | `{ ok }` |
| `sense.pause` | `{ minutes? }` | `{ ok, resumeAt }` |
| `sense.resume` | — | `{ ok }` |
| `sense.now` | — | `{ capture?, events, app, window, clipboard? }` |
| `sense.today` | — | `{ sessions, apps, timeline }` |
| `sense.search` | `{ query, limit? }` | `SenseCapture[]` |
| `sense.apps` | `{ range }` | `{ app, duration, captureCount }[]` |
| `sense.timeline` | `{ from?, to? }` | `(SenseCapture | SenseEvent)[]` |
| `sense.settings` | — | `SenseSettings` |
| `sense.updateSettings` | `{ updates }` | `SenseSettings` |
| `sense.clear` | `{ range }` | `{ deletedCount }` |
| `sense.stats` | — | `{ storageBytes, captureCount, eventCount, sessionCount, oldestCapture }` |

### Phase 7: Settings UI + Tray Indicator

**`src/renderer/components/SettingsView.vue`** — Add Sense settings section with toggle, tier indicator, interval slider, blacklist management, storage display, retention controls.

**`src/main/index.ts`** or **`src/main/tray.ts`** — Update tray icon state when Sense is recording. Add "Sense: Recording / Paused / Off" to tray context menu with quick toggle.

---

## Files Changed (complete list)

| File | Action | Purpose |
|------|--------|---------|
| `src/native/ocr-helper.m` | **create** | Apple Vision OCR native helper |
| `src/native/window-helper.m` | **create** | CGWindowList native helper |
| `src/native/accessibility-helper.m` | **create** | AXUIElement tree walker native helper |
| `scripts/build-native-helpers.sh` | **create** | Compile script for native binaries |
| `src/shared/session.ts` | modify | Add Sense types |
| `src/daemon/db.ts` | modify | Add Sense table migrations |
| `src/daemon/sense/presence.ts` | **create** | Presence monitor |
| `src/daemon/sense/metadata.ts` | **create** | Tier 0 metadata collection (app/window polling) |
| `src/daemon/sense/recorder.ts` | **create** | Screen capture recorder |
| `src/daemon/sense/window-detector.ts` | **create** | Window detection wrapper |
| `src/daemon/sense/accessibility.ts` | **create** | Accessibility tree extraction wrapper |
| `src/daemon/sense/ocr.ts` | **create** | OCR extraction wrapper |
| `src/daemon/sense/text-router.ts` | **create** | Accessibility vs. OCR routing |
| `src/daemon/sense/redaction.ts` | **create** | Security redaction engine |
| `src/daemon/sense/markdown.ts` | **create** | Markdown generation |
| `src/daemon/sense/worker.ts` | **create** | Text extraction processing worker |
| `src/daemon/sense/indexer.ts` | **create** | SQLite indexer + FTS5 |
| `src/daemon/sense/storage.ts` | **create** | Retention + cleanup |
| `src/daemon/sense/controller.ts` | **create** | State machine controller |
| `src/daemon/sense/privacy.ts` | **create** | Blacklist + capture privacy |
| `src/daemon/sense/clipboard.ts` | **create** | Clipboard mirroring |
| `src/daemon/server.ts` | modify | Register Sense RPC methods |
| `src/main/index.ts` | modify | IPC handlers + tray indicator |
| `src/preload/index.ts` | modify | Expose Sense bridge methods |
| `src/cli/sense.ts` | **create** | CLI implementation |
| `bin/bond` | modify | Add `sense` command |
| `package.json` | modify | Build scripts for native helpers + CLI |
| `src/daemon/agent.ts` | modify | System prompt + auto-context injection |
| `src/renderer/components/SettingsView.vue` | modify | Sense settings section |

---

## Build Order

1. **Tier 0 metadata** — Presence, app/window polling, clipboard, controller, basic RPC, system prompt injection. Testable immediately via CLI. Zero native code, zero permissions.
2. **Native helpers** — Compile and test OCR + window detection + accessibility binaries independently
3. **Tier 1 pipeline** — Recorder → window detector → text router (accessibility → OCR) → redaction → markdown → worker → indexer → controller upgrade. Test each component in isolation.
4. **IPC + CLI** — Bridge methods, full subcommand set, testable end-to-end
5. **Agent integration** — System prompt upgrade + auto-context
6. **Settings UI + tray** — Toggle, blacklist, storage management, recording indicator

The key insight: **Tier 0 ships first and is immediately useful.** Bond gets basic awareness (which app, which window, what's on clipboard) without needing native helpers or macOS permissions. Tier 1 adds depth (screenshots, full text extraction, searchable history) when the user opts in.

---

## Not in v1

- **Adaptive frame similarity detection** (skip near-identical frames) — event-driven triggers handle the worst of the waste; similarity is a v2 optimization
- **Embeddings / semantic search** — FTS5 keyword search is sufficient initially
- **Proactive suggestions** ("you've been context-switching a lot") — requires behavioral model
- **Meeting detection** (Zoom/Meet awareness, slide capture) — specialized logic deferred
- **Cross-device sync** — local only
- **Sense timeline view in UI** — CLI + chat access first, dedicated view later
- **Video recording** — stills only, video is a resource disaster (see Rewind: 200%+ CPU)
- **Bond-embed for Sense** — no `<bond-embed type="sense" />` in v1, CLI output in chat is fine
- **MCP server exposure** — exposing Sense data via MCP for other AI tools is a natural v2 feature, but internal RPC + CLI comes first
- **FSEvents file system monitoring** — watching project directories for file changes is appealing but adds complexity; window titles already capture "which file is open" for most editors
