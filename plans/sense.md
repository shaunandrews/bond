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

### Process Boundary: Main Process vs. Daemon

Bond's daemon is a standalone Node.js process — it has **no access to Electron APIs**. This is a hard constraint that shapes where each piece of Sense lives:

| Capability | Where it runs | Why |
|-----------|---------------|-----|
| Screenshot capture (`desktopCapturer`) | **Electron main process** | Electron-only API — `desktopCapturer` is only available in main/renderer, not a standalone Node process. Screen Recording permission is granted to the Bond.app bundle. |
| Permission checks (`systemPreferences`) | **Electron main process** | Electron-only API |
| Idle detection | **Daemon** | `ioreg -c IOHIDSystem` — pure shell, no Electron needed |
| Window/app detection | **Daemon** | `bond-window-helper` native binary via `child_process.spawn()` |
| Accessibility tree extraction | **Daemon** | `bond-accessibility-helper` native binary |
| OCR extraction | **Daemon** | `bond-ocr-helper` native binary |
| Text routing, redaction, indexing | **Daemon** | Pure JS/SQLite |
| State machine (controller) | **Daemon** | Owns all Sense state |
| Clipboard monitoring | **Daemon** | Async `child_process.execFile('pbpaste')` polling |
| Tray icon state | **Electron main process** | Electron `Tray` API |

### Capture Flow: Daemon → Main Process → Daemon

The daemon cannot capture screenshots — `desktopCapturer` is an Electron API, and Screen Recording permission is granted to the Bond.app bundle, not the daemon process. This means capture follows a request/callback pattern using the existing `BondClient` WebSocket connection:

```
Daemon (brain)                             Main Process (eyes)
──────────────                             ────────────────────
Controller timer fires
  → bond-window-helper (pre-capture)
  → blacklist check passes
  → broadcast sense.requestCapture ──────→ desktopCapturer.getSources()
    (notification, same pattern as           → select display under cursor
     bond.chunk, todo.changed)               → NativeImage.toJPEG(80)
                                             → write to sense/stills/
sense.captureReady { imagePath } ←────────   → RPC call back to daemon
  → bond-window-helper (post-capture)
  → blacklist recheck
  → text extraction queue
    → bond-accessibility-helper
    → bond-ocr-helper (fallback)
    → redact → index → update DB
```

**How the reverse communication works**: The daemon broadcasts a `sense.requestCapture` notification to all connected clients — the same fire-and-forget pattern used for `bond.chunk`, `todo.changed`, and `project.changed` notifications. The main process's `BondClient` already listens for notifications via `onNotification` handlers. On receiving `sense.requestCapture`, the main process:

1. Calls `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })` at 0.5x display resolution
2. Selects the source for the display under the cursor via `screen.getCursorScreenPoint()` + `screen.getDisplayNearestPoint()`
3. Encodes the thumbnail to JPEG via `NativeImage.toJPEG(80)` — no hidden BrowserWindow needed (Familiar uses one for WebP encoding, but JPEG is available directly from `NativeImage`)
4. Writes the buffer to `sense/stills/{date}/{timestamp}.jpg`
5. Calls `sense.captureReady` RPC back to the daemon with `{ imagePath }`

**Path resolution**: The main process receives the capture directory path from the daemon in the `sense.requestCapture` notification payload (`{ captureDir }`). The daemon computes it from `getDataDir()` — same as image storage for chat.

The daemon is the "brain" (state machine, processing, storage, queries) and initiates capture requests. The main process is the "eyes" (takes screenshots, checks permissions, manages tray) and responds to daemon requests.

### Permission Requirement

Sense requires **Screen Recording** permission (macOS system permission). When the user enables Sense, Bond checks permission status via `systemPreferences.getMediaAccessStatus('screen')` in the Electron main process. If not granted, Bond guides the user to System Settings — Sense does not run without it.

**Accessibility** permission is optional but recommended. It enables richer text extraction via the AXUIElement tree (structured labels, headings, values). Without it, Sense falls back to OCR-only — same screenshots, just a different text extraction path.

Sense captures:
- Screenshot capture (JPEG, 0.5x scale via Electron main process)
- Active app name + window title + bundle ID (via `bond-window-helper`)
- Accessibility tree extraction (primary text source, when permission granted)
- OCR via Apple Vision (fallback for non-native apps)
- Clipboard text changes (via `pbpaste` polling)
- FTS5 full-text search across all captured text

**Why JPEG, not WebP:** Apple Vision's `VNRecognizeTextRequest` reads via CGImage/ImageIO. WebP support in ImageIO was only added in macOS 14 (Sonoma). JPEG is universally supported, produces comparable file sizes at the 0.5x scale used here, and avoids a macOS version floor.

### Core Pipeline

```
Idle Detection (ioreg -c IOHIDSystem, polled every 5s)
    → HIDIdleTime in nanoseconds → seconds
    → Controls recording state

Window Detection (bond-window-helper, per capture + polled every 2s)
    → App name, window title, bundle ID
    → Pre/post capture blacklist checks
    → App switch triggers event-driven captures

Screen Capture (Electron main process, desktopCapturer)
    → JPEG saved to sense/stills/
    → Daemon notified via RPC

Text Extraction (daemon, native helpers)
    → Accessibility tree (primary, via bond-accessibility-helper)
    → OCR (fallback, via bond-ocr-helper)
    → Security redaction (regex-based)
    → Indexed in SQLite with FTS5

Clipboard Monitor (pbpaste, polled every 500ms)
    → Text saved with timestamp
    → Stored on captures
```

### Capture Triggers (Hybrid: Event-Driven + Interval)

Instead of fixed-interval-only capture, Sense uses a hybrid approach from v1:

**Event-driven triggers** (capture immediately):
- App/window focus change (detected by polling `bond-window-helper` every 2s and comparing to previous result)
- Significant clipboard change (>1 word, different from last)

**Interval baseline** (configurable, default 15s):
- Runs between event-driven captures
- Ensures continuous coverage during sustained work in one app
- Drops to 30s on battery / low power mode

**Why 15s default, not 5s:** Without frame similarity detection (deferred to v2), a 5s interval produces ~5,760 captures per 8-hour day — roughly 800MB+ of JPEG storage. At 15s the interval alone produces ~1,920 captures (~270MB), and event-driven triggers fill in the important transitions. This keeps v1 storage in the ~300MB/day target without needing deduplication.

The event-driven triggers catch context transitions — the most valuable moments — while the interval fills in the gaps. This is more efficient than pure interval and produces better data at app boundaries.

### Components

| Component | What it does | Where it runs | Implementation |
|-----------|-------------|---------------|----------------|
| **Presence monitor** | Detects user active/idle/locked/suspended. Recording only runs when active. | Daemon | Polls `ioreg -c IOHIDSystem` every 5s, parses `HIDIdleTime` (nanoseconds → seconds). Threshold-based: idle after 60s of no input. |
| **Screen recorder** | Captures screenshots from the active display on request from the daemon. | Electron main process | Listens for `sense.requestCapture` notification. Calls `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })` at 0.5x scale → selects display under cursor → `NativeImage.toJPEG(80)` → saves to `sense/stills/` → calls `sense.captureReady` RPC back to daemon. No hidden BrowserWindow needed — JPEG encoding is available directly from `NativeImage`. |
| **Window detector** | Identifies the active app, window title, bundle ID, and all visible windows. Runs before AND after each capture to reject ambiguous frames where focus changed mid-capture. Also polled every 2s to detect app switches for event-driven capture triggers. | Daemon | `bond-window-helper` native binary (Objective-C). Uses `CGWindowListCopyWindowInfo` + NSWorkspace. |
| **Accessibility extractor** | Walks the AXUIElement tree for the focused app to extract structured text content — labels, headings, text fields, values. Primary text source for native apps. | Daemon | `bond-accessibility-helper` native binary (Objective-C). Uses Accessibility API (`AXUIElementCopyAttributeValue`). Requires Accessibility permission (optional — falls back to OCR-only without it). |
| **OCR extractor** | Extracts text lines from screenshots using Apple Vision framework (`VNRecognizeTextRequest`). Fallback for apps where accessibility tree is sparse. | Daemon | `bond-ocr-helper` native binary (Objective-C). Runs in batches, max 2 parallel processes to limit CPU. |
| **Text source router** | Decides whether to use accessibility tree, OCR, or both for a given capture. Caches extraction quality per app bundle ID. | Daemon | JS. Try accessibility first. Cache character count per bundle ID. If cached quality is <20 chars for this app, skip straight to OCR. If first attempt for an app returns <20 chars, mark it as OCR-preferred and queue OCR. |
| **Redaction engine** | Scans extracted text for passwords, API keys, card numbers, secrets. Redacts or drops entire frames containing payment info. | Daemon | Pure JS regex. No bundled ripgrep — unnecessary dependency for pattern matching. |
| **Indexer** | Inserts capture metadata + text into SQLite for fast querying. Full-text search via FTS5. | Daemon | SQLite. Runs after text extraction completes. |
| **Capture privacy** | App blacklist — never capture when blacklisted apps are visible (banking, password managers, etc.). User-configurable. | Daemon | JS. Checks visible window names against blacklist before and after capture. |
| **Clipboard mirror** | Polls clipboard every 500ms, saves text content when it changes. Skips single-word entries (too noisy). | Daemon | Async `child_process.execFile('pbpaste')` polling — never blocks the event loop. |
| **Tray indicator** | Menu bar icon showing Sense state (recording/paused/off). Context menu with quick toggle. | Electron main process | Electron `Tray` API. State pushed from daemon via WebSocket events. |

### Capture Lifecycle

1. Presence monitor detects `active` (idle time < threshold) → controller transitions to `recording` state
2. On each capture trigger (event-driven or interval):
   - **Daemon:** Detect visible windows via `bond-window-helper` (pre-capture snapshot)
   - **Daemon:** Check blacklist — skip if sensitive app visible
   - **Daemon:** Send `sense.requestCapture` to main process via WebSocket broadcast
   - **Main process:** Capture screenshot via `desktopCapturer`, save JPEG to `sense/stills/`, call `sense.captureReady` RPC back to daemon with `{ imagePath }`
   - **Daemon:** Detect visible windows again (post-capture snapshot)
   - **Daemon:** Check blacklist again — discard frame if sensitive app appeared during capture
   - **Daemon:** Compare pre/post snapshots — if active window changed mid-capture, record as ambiguous
   - **Daemon:** Route to text extraction (accessibility tree → OCR fallback)
3. Text extraction worker processes queue:
   - Check bundle ID cache — skip accessibility if app is known OCR-preferred
   - Try accessibility tree first for focused app
   - If sparse (<20 chars), mark app as OCR-preferred in cache, queue OCR
   - Extracted text → redaction scan → SQLite index
4. Presence monitor detects `idle` (idle time > threshold) → controller transitions to `idle`, closes session
5. System sleep detected (main process forwards `powerMonitor` `suspend` event) → controller transitions to `suspended`, closes session immediately. On `resume` event → transitions back to `armed`

### Recovery on Restart

When the daemon starts, it checks for stale state:
- Captures with `text_status = 'pending'` or `'processing'` are re-queued for text extraction
- Open sessions with no `ended_at` are closed with the last capture's timestamp
- Settings are loaded — if `enabled` was true, controller transitions to `armed` (waiting for user activity)

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
  created_at TEXT NOT NULL
);

-- Individual captures
CREATE TABLE sense_captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sense_sessions(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  image_path TEXT,                               -- NULL after retention purge deletes the image
  app_name TEXT,
  app_bundle_id TEXT,
  window_title TEXT,
  visible_windows TEXT DEFAULT '[]',             -- JSON array
  text_source TEXT NOT NULL DEFAULT 'pending',   -- pending | accessibility | ocr | both | failed
  text_status TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | done | failed
  text_content TEXT,                             -- extracted text (accessibility and/or OCR), survives image purge
  capture_trigger TEXT,                          -- app_switch | interval | clipboard
  ambiguous INTEGER NOT NULL DEFAULT 0,          -- 1 if active window changed mid-capture
  image_purged_at TEXT,                          -- set when image deleted by retention cleanup
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sense_captures_session ON sense_captures(session_id);
CREATE INDEX idx_sense_captures_time ON sense_captures(captured_at DESC);
CREATE INDEX idx_sense_captures_app ON sense_captures(app_name);
CREATE INDEX idx_sense_captures_status ON sense_captures(text_status);

-- Full-text search on extracted text content
-- External content table: FTS5 reads from sense_captures but we manage inserts/deletes manually
CREATE VIRTUAL TABLE sense_fts USING fts5(
  text_content,
  app_name,
  window_title,
  content=sense_captures,
  content_rowid=rowid
);

-- Sync triggers — required for external content FTS5 tables
CREATE TRIGGER sense_fts_insert AFTER INSERT ON sense_captures
  WHEN NEW.text_content IS NOT NULL BEGIN
    INSERT INTO sense_fts(rowid, text_content, app_name, window_title)
    VALUES (NEW.rowid, NEW.text_content, NEW.app_name, NEW.window_title);
END;

CREATE TRIGGER sense_fts_update AFTER UPDATE OF text_content ON sense_captures
  WHEN NEW.text_content IS NOT NULL BEGIN
    INSERT INTO sense_fts(sense_fts, rowid, text_content, app_name, window_title)
    VALUES ('delete', OLD.rowid, OLD.text_content, OLD.app_name, OLD.window_title);
    INSERT INTO sense_fts(rowid, text_content, app_name, window_title)
    VALUES (NEW.rowid, NEW.text_content, NEW.app_name, NEW.window_title);
END;

CREATE TRIGGER sense_fts_delete AFTER DELETE ON sense_captures
  WHEN OLD.text_content IS NOT NULL BEGIN
    INSERT INTO sense_fts(sense_fts, rowid, text_content, app_name, window_title)
    VALUES ('delete', OLD.rowid, OLD.text_content, OLD.app_name, OLD.window_title);
END;

-- Text source router cache — tracks which apps produce good accessibility data
CREATE TABLE sense_app_text_quality (
  bundle_id TEXT PRIMARY KEY,
  preferred_source TEXT NOT NULL DEFAULT 'accessibility',  -- accessibility | ocr
  avg_accessibility_chars INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

### File storage

```
~/Library/Application Support/bond/sense/
  stills/
    2026-04-04/
      2026-04-04T10-30-00.jpg
      2026-04-04T10-30-15.jpg
      ...
```

Images only — no markdown files, no clipboard files. All text and metadata lives in SQLite. Directories organized by date for easy manual inspection and cleanup.

### Storage management

- **Tiered retention**: Full fidelity (images + text + index) for 14 days. After that, images are deleted (`image_path` set to NULL, `image_purged_at` set) but `text_content` + index retained for 90 days. After 90 days, entire capture rows purged.
- **Storage cap**: Auto-cleanup when sense data exceeds configurable limit (default 2GB). Oldest images purged first (same as retention, just accelerated). If still over cap after image purge, oldest capture rows deleted.
- **Manual purge**: User can clear all data or a specific date range.

**Expected storage**: ~300 MB per 8-hour workday with 15s interval + event-driven triggers. Roughly ~1,920 interval captures + ~200 event-driven captures per 8-hour day. At ~140KB per JPEG (0.5x 1512px wide), that's ~300MB. Text index adds negligible overhead.

---

## Native Helpers

Three Objective-C binaries, compiled and shipped in Bond's app resources. All spawned from the daemon via `child_process.spawn()` — the daemon already uses this pattern (Electron main process spawns the daemon itself the same way).

### 1. `bond-ocr-helper`

Wraps Apple Vision framework's `VNRecognizeTextRequest`.

**Input**: image path (JPEG or PNG), recognition level (accurate/fast), language hints, min confidence
**Output**: JSON with `meta` (image dimensions, languages, confidence) and `lines` (array of recognized text strings)

```bash
bond-ocr-helper --image /path/to/capture.jpg --level accurate --min-confidence 0.0
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
mkdir -p out/daemon/bin/sense
xcrun clang -framework Foundation -framework Vision -o out/daemon/bin/sense/bond-ocr-helper src/native/ocr-helper.m
xcrun clang -framework Foundation -framework AppKit -framework CoreGraphics -o out/daemon/bin/sense/bond-window-helper src/native/window-helper.m
xcrun clang -framework Foundation -framework AppKit -framework ApplicationServices -o out/daemon/bin/sense/bond-accessibility-helper src/native/accessibility-helper.m
```

Binaries ship via `extraResources` in `electron-builder.yml`:

```yaml
# Add to existing extraResources array
- from: out/daemon/bin/sense
  to: daemon/bin/sense
  filter:
    - "**/*"
```

At runtime, the daemon resolves the binary path:
```typescript
// In dev: process.cwd() + '/out/daemon/bin/sense/bond-ocr-helper'
// Packaged: process.resourcesPath + '/daemon/bin/sense/bond-ocr-helper'
```

This follows the same pattern Bond already uses for the daemon itself and the Agent SDK's bundled ripgrep.

---

## Privacy & Security

### Permissions required

- **Screen Recording**: macOS system permission, required for Sense to function. `desktopCapturer` returns blank frames without this permission. Bond checks on enable and guides the user to System Settings if not granted.
- **Accessibility** (optional but recommended): For accessibility tree text extraction. Without it, OCR is the only text source. Many users already grant this for other tools.

### Permission flow

On first enable, the **Electron main process** checks permissions and guides the user (the daemon cannot access `systemPreferences`):

1. Main process checks `systemPreferences.getMediaAccessStatus('screen')`
2. If not granted, renderer shows a dialog explaining what Sense does and why Screen Recording is needed
3. Main process opens System Settings to the right pane via `shell.openExternal('x-apple.systempreferences:...')`
4. Main process polls permission status until granted, then notifies daemon to start
5. Optionally guide user to grant Accessibility permission for richer text extraction (separate from Screen Recording)

### App blacklist

Default blacklist (user can add/remove):
- 1Password, Bitwarden, LastPass, KeePassXC
- Keychain Access
- Banking apps (detected by bundle ID patterns)
- Private/incognito browser windows (best-effort detection by window title — Safari: "Private Browsing", Chrome: "Incognito", Firefox: "Private Browsing"; note that Arc and some browsers don't indicate private mode in the title, so this is not reliable for all browsers)

Blacklist check runs twice per capture — before AND after — to catch apps that appear mid-capture. If any blacklisted app is visible in either snapshot, the frame is discarded entirely (image deleted, nothing indexed).

Blacklist applies to all capture data — no app name, window title, or text is recorded for blacklisted apps.

### Redaction

Regex-based scanning of extracted text before indexing in SQLite:
- API keys (AWS, GitHub, Stripe, OpenAI, Anthropic, Google, Slack, SendGrid, Twilio) → replaced with `[REDACTED_API_KEY]`
- Bearer tokens, JWTs → `[REDACTED_TOKEN]`
- Passwords in plaintext (common patterns like `password: ...`, `api_key=...`, `secret=...`) → `[REDACTED]`
- URLs with embedded credentials (`https://user:pass@host`) → credentials stripped
- Credit card numbers (Luhn-valid 13-19 digit sequences) + payment keywords → **entire frame dropped** (not just redacted)
- SSN patterns → `[REDACTED_SSN]`

### Data locality

All data stays on disk. Never sent to any server. OCR and accessibility extraction run locally. The only time capture data leaves the machine is when the user explicitly asks Bond to analyze it in conversation (at which point it's sent to the AI provider as conversation context, same as any other user-provided content).

### Recording indicator

Menu bar tray icon (Electron `Tray` API, main process) changes state when Sense is actively recording. Not hidden — the user should always know when captures are happening. Matches macOS conventions for screen recording indicators. Daemon pushes state changes to the main process via WebSocket events; main process updates the tray icon accordingly.

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
  captureIntervalSeconds: number      // default 15
  lowPowerIntervalSeconds: number     // default 30
  idleThresholdSeconds: number        // default 60
  eventDrivenCapture: boolean         // capture on app switch, default true
  retentionDays: number               // full fidelity (images + text), default 14
  textRetentionDays: number           // text + index only (images purged), default 90
  storageCapMb: number                // auto-cleanup threshold, default 2048
  blacklistedApps: string[]           // bundle IDs to never capture
  autoContextInChat: boolean          // inject recent context into conversations, default false
  clipboardCapture: boolean           // mirror clipboard contents, default true
  textExtractionPreference: 'auto' | 'accessibility' | 'ocr'  // default 'auto' (accessibility first, OCR fallback)
}
```

**Storage:** Serialized as a single JSON string via the existing `setSetting('sense', JSON.stringify(settings))` / `getSetting('sense')` mechanism. Same key-value pattern used by soul, model, and accent color.

### Settings UI

Add a "Sense" section to Bond's settings panel:
- Master toggle with permission status indicator
- Capture interval slider
- Event-driven capture toggle
- Text extraction preference (Auto / Accessibility only / OCR only)
- Blacklisted apps list (add/remove)
- Storage usage display with clear button
- Retention period selector
- Auto-context toggle

---

## Implementation Plan

### Phase 1: Native Helpers + Types + Database

Build all three native binaries and the foundation they plug into.

1. **`src/native/window-helper.m`** — Port Familiar's CGWindowList helper. `CGWindowListCopyWindowInfo` + NSWorkspace for app name, bundle ID, window title, PID, active state.
2. **`src/native/ocr-helper.m`** — Port Familiar's Apple Vision OCR wrapper. `VNRecognizeTextRequest` on JPEG/PNG input → JSON lines output.
3. **`src/native/accessibility-helper.m`** — AXUIElement tree walker for structured text extraction. Reference: MacPaw's [macapptree](https://github.com/MacPaw/macapptree).
4. **`scripts/build-native-helpers.sh`** — Compile script for all three. Add `build:native` to `package.json`.
5. **`electron-builder.yml`** — Add `extraResources` entry for `out/daemon/bin/sense/`
6. **`src/shared/sense.ts`** — `SenseSession`, `SenseCapture`, `SenseSettings` types
7. **`src/daemon/db.ts`** — Add `migrateCreateSenseTables()` migration (sessions, captures, FTS5, sync triggers, app_text_quality)
8. **Tests** — Integration tests for each helper binary (spawn, pass test input, verify JSON output)

### Phase 2: Daemon Capture Pipeline

The core capture loop and all its components.

1. **`src/daemon/sense/presence.ts`** — Presence monitor. Polls `ioreg -c IOHIDSystem` every 5s, parses `HIDIdleTime` (nanoseconds → seconds). Emits `active` / `idle` based on threshold.
2. **`src/daemon/sense/window-detector.ts`** — Wrapper around `bond-window-helper` binary. Polled every 2s for app-switch event detection. Also used for pre/post capture snapshots.
3. **`src/daemon/sense/clipboard.ts`** — Clipboard mirroring. Polls `pbpaste` via async `child_process.execFile()` every 500ms. Never blocks the event loop. Skips single-word entries.
4. **`src/daemon/sense/privacy.ts`** — Blacklist checking. Checks visible windows against blacklist before and after capture.
5. **`src/daemon/sense/accessibility.ts`** — Wrapper around `bond-accessibility-helper` binary
6. **`src/daemon/sense/ocr.ts`** — Wrapper around `bond-ocr-helper` binary + batch processing (max 2 parallel)
7. **`src/daemon/sense/text-router.ts`** — Decides accessibility vs. OCR per capture. Reads `sense_app_text_quality` cache by bundle ID. Tries accessibility first; if <20 chars, marks app as OCR-preferred, queues OCR.
8. **`src/daemon/sense/redaction.ts`** — Regex-based security redaction
9. **`src/daemon/sense/worker.ts`** — Queue-based text extraction worker. Polls `text_status = 'pending'` captures, processes batches. On daemon startup, re-queues captures stuck in `'processing'`.
10. **`src/daemon/sense/indexer.ts`** — Updates `text_content` column on `sense_captures` (FTS5 sync happens via triggers)
11. **`src/daemon/sense/storage.ts`** — Retention enforcement, auto-cleanup, storage stats
12. **`src/daemon/sense/controller.ts`** — State machine: `disabled` → `armed` → `recording` → `idle` → `paused` → `suspended`. Orchestrates presence, window detection, capture triggers (event-driven + interval), and the full capture lifecycle. `suspended` state entered on system sleep (via `powerMonitor` events forwarded from main process); transitions back to `armed` on wake.
13. **Tests** — `presence.test.ts`, `clipboard.test.ts`, `privacy.test.ts`, `controller.test.ts`, `text-router.test.ts`, `redaction.test.ts`, `worker.test.ts`, `storage.test.ts`

### Phase 3: Main Process + IPC

Screenshot capture and permission handling in the Electron main process.

1. **`src/main/sense.ts`** — Capture coordinator. Listens for `sense.requestCapture` notifications from the daemon's `BondClient` connection. On notification: calls `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })` at 0.5x display resolution, selects display under cursor via `screen.getCursorScreenPoint()`, encodes via `NativeImage.toJPEG(80)`, writes to the `captureDir` path provided in the notification, then calls `sense.captureReady` RPC back to the daemon. Also handles permission checks (`systemPreferences.getMediaAccessStatus('screen')`), permission flow UI, and forwards `powerMonitor` suspend/resume events to the daemon.
2. **`src/main/index.ts`** — `ipcMain.handle('sense:*')` handlers. Some proxy to daemon (search, settings, stats), others are main-process-native (capture, permissions). Init sense module on app ready.
3. **`src/preload/index.ts`** — `window.bond.sense*` bridge methods

### Phase 4: Server RPC + CLI

All RPC methods and the CLI that calls them.

1. **`src/daemon/server.ts`** — Register Sense RPC methods:

| Method | Params | Returns |
|--------|--------|---------|
| `sense.status` | — | `{ enabled, state, lastCapture, sessionCount, storageBytes }` |
| `sense.enable` | — | `{ ok }` |
| `sense.disable` | — | `{ ok }` |
| `sense.pause` | `{ minutes? }` | `{ ok, resumeAt }` |
| `sense.resume` | — | `{ ok }` |
| `sense.captureReady` | `{ imagePath, displayId }` | `{ ok }` — called by main process after capture |
| `sense.permissionChanged` | `{ screen, accessibility }` | `{ ok }` — called by main process on permission change |
| `sense.now` | — | `{ capture?, app, window, clipboard? }` |
| `sense.today` | — | `{ sessions, apps, timeline }` |
| `sense.search` | `{ query, limit? }` | `SenseCapture[]` |
| `sense.apps` | `{ range }` | `{ app, duration, captureCount }[]` |
| `sense.timeline` | `{ from?, to? }` | `SenseCapture[]` |
| `sense.settings` | — | `SenseSettings` |
| `sense.updateSettings` | `{ updates }` | `SenseSettings` |
| `sense.clear` | `{ range }` | `{ deletedCount }` |
| `sense.stats` | — | `{ storageBytes, captureCount, sessionCount, oldestCapture }` |

**Notifications (daemon → clients):** `sense.requestCapture` is broadcast as a fire-and-forget notification (same pattern as `bond.chunk`, `todo.changed`). The main process listens for it and initiates capture. `sense.stateChanged` broadcasts state transitions so the main process can update the tray icon.

**Main process → daemon:** `sense.captureReady` and `sense.permissionChanged` are called by the Electron main process back to the daemon via RPC. All other methods are called by the CLI, renderer (via IPC), or agent (via tools).

2. **`src/cli/sense.ts`** — Full CLI: `status`, `on`, `off`, `pause`, `resume`, `now`, `today`, `yesterday`, `week`, `search`, `apps`, `timeline`, `exclude`, `include`, `excluded`, `clear`, `stats`, `config`. Same WebSocket pattern as `todo.ts`.
3. **`bin/bond`** — Add `sense` command dispatch
4. **`package.json`** — Add to `build:cli` esbuild targets

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

Auto-context injection: when enabled in settings, include a compressed summary of recent screen context in the system prompt (active app, previous apps, key visible text, recent clipboard).

### Phase 6: Settings UI + Tray Indicator

**`src/renderer/components/SettingsView.vue`** — Add Sense settings section with toggle, permission status indicator, interval slider, blacklist management, storage display, retention controls.

**`src/main/tray.ts`** — New file. Tray icon with context menu: "Sense: Recording / Paused / Off" + quick toggle. State driven by daemon WebSocket events.
**`src/main/index.ts`** — Initialize tray on app ready.

---

## Files Changed (complete list)

### Native helpers
| File | Action | Purpose |
|------|--------|---------|
| `src/native/window-helper.m` | **create** | CGWindowList native helper |
| `src/native/ocr-helper.m` | **create** | Apple Vision OCR native helper |
| `src/native/accessibility-helper.m` | **create** | AXUIElement tree walker native helper |
| `scripts/build-native-helpers.sh` | **create** | Compile script for native binaries |

### Shared types
| File | Action | Purpose |
|------|--------|---------|
| `src/shared/sense.ts` | **create** | SenseSession, SenseCapture, SenseSettings types |
| `src/shared/client.ts` | modify | Add Sense RPC methods to `BondClient` (status, enable, disable, search, etc.) |

### Daemon
| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/db.ts` | modify | Add Sense table migrations (sessions, captures, FTS5, app_text_quality) |
| `src/daemon/sense/presence.ts` | **create** | Idle detection via `ioreg` polling |
| `src/daemon/sense/clipboard.ts` | **create** | Clipboard mirroring via `pbpaste` |
| `src/daemon/sense/privacy.ts` | **create** | Blacklist checking, capture privacy |
| `src/daemon/sense/controller.ts` | **create** | State machine (disabled/armed/recording/idle/paused) |
| `src/daemon/sense/window-detector.ts` | **create** | Pre/post capture window detection wrapper |
| `src/daemon/sense/accessibility.ts` | **create** | Accessibility tree extraction wrapper |
| `src/daemon/sense/ocr.ts` | **create** | OCR extraction wrapper + batch processing |
| `src/daemon/sense/text-router.ts` | **create** | Accessibility vs. OCR routing with per-app cache |
| `src/daemon/sense/redaction.ts` | **create** | Security redaction engine |
| `src/daemon/sense/worker.ts` | **create** | Queue-based text extraction worker |
| `src/daemon/sense/indexer.ts` | **create** | SQLite text_content updates (FTS5 synced via triggers) |
| `src/daemon/sense/storage.ts` | **create** | Retention enforcement + auto-cleanup |
| `src/daemon/server.ts` | modify | Register Sense RPC methods |
| `src/daemon/agent.ts` | modify | System prompt + auto-context injection |

### Electron main process
| File | Action | Purpose |
|------|--------|---------|
| `src/main/sense.ts` | **create** | Screenshot capture coordinator (desktopCapturer), permission checks, powerMonitor forwarding |
| `src/main/tray.ts` | **create** | Menu bar tray icon with Sense state + quick toggle |
| `src/main/index.ts` | modify | IPC handlers, tray init, sense module init |

### Preload + Renderer
| File | Action | Purpose |
|------|--------|---------|
| `src/preload/index.ts` | modify | Expose `window.bond.sense*` bridge methods |
| `src/renderer/components/SettingsView.vue` | modify | Sense settings section |

### CLI + Build
| File | Action | Purpose |
|------|--------|---------|
| `src/cli/sense.ts` | **create** | CLI implementation (all subcommands) |
| `bin/bond` | modify | Add `sense` command dispatch |
| `package.json` | modify | `build:native` script, CLI esbuild target |
| `electron-builder.yml` | modify | `extraResources` entry for native binaries |

### Tests
| File | Action | Purpose |
|------|--------|---------|
| `src/daemon/sense/presence.test.ts` | **create** | Presence monitor unit tests |
| `src/daemon/sense/clipboard.test.ts` | **create** | Clipboard mirror tests |
| `src/daemon/sense/privacy.test.ts` | **create** | Blacklist logic tests |
| `src/daemon/sense/controller.test.ts` | **create** | State machine tests |
| `src/daemon/sense/text-router.test.ts` | **create** | Text source routing + cache tests |
| `src/daemon/sense/redaction.test.ts` | **create** | Redaction pattern tests |
| `src/daemon/sense/worker.test.ts` | **create** | Text extraction worker tests |
| `src/daemon/sense/storage.test.ts` | **create** | Retention + cleanup tests |

---

## Build Order

1. **Native helpers + types + database** — Build all three Objective-C binaries, shared types, and database migrations. Test each binary in isolation.
2. **Daemon capture pipeline** — Presence, window detection, clipboard, privacy, text extraction (accessibility → OCR → routing), redaction, indexer, storage, controller state machine. Test each component.
3. **Main process + IPC** — Screenshot capture via `desktopCapturer`, permission flow, `powerMonitor` forwarding, IPC handlers, preload bridge.
4. **Server RPC + CLI** — All `sense.*` RPC methods + full CLI. Testable end-to-end.
5. **Agent integration** — System prompt with screen context, auto-context injection.
6. **Settings UI + tray** — Toggle, blacklist, storage management, recording indicator.

Screen Recording permission is required — Sense does not run without it. The CLI ships with Phase 4 so the full pipeline is testable before building UI.

---

## Not in v1

- **Adaptive frame similarity detection** (skip near-identical frames) — 15s interval + event-driven triggers keep storage manageable; similarity detection is the v2 optimization that enables lowering the interval to 5s
- **Markdown export files** — Familiar needed markdown files because it had no database; Bond has SQLite + RPC + CLI. If MCP exposure or external tool integration happens in v2, markdown export can be added then
- **Embeddings / semantic search** — FTS5 keyword search is sufficient initially
- **Proactive suggestions** ("you've been context-switching a lot") — requires behavioral model
- **Meeting detection** (Zoom/Meet awareness, slide capture) — specialized logic deferred
- **Cross-device sync** — local only
- **Sense timeline view in UI** — CLI + chat access first, dedicated view later
- **Video recording** — stills only, video is a resource disaster (see Rewind: 200%+ CPU)
- **Bond-embed for Sense** — no `<bond-embed type="sense" />` in v1, CLI output in chat is fine
- **MCP server exposure** — exposing Sense data via MCP for other AI tools is a natural v2 feature, but internal RPC + CLI comes first
- **FSEvents file system monitoring** — watching project directories for file changes is appealing but adds complexity; window titles already capture "which file is open" for most editors
