# Sense Timeline UI

A new "Sense" tab in Bond's main view — a visual, scrubbable timeline of screen activity. Time Machine meets DVR: scrub through your day, see what you were doing, search for anything you saw.

---

## Current State

**Backend (complete):**
- Captures every 15s + event-driven on app switch/clipboard
- OCR + accessibility text extraction pipeline with per-app quality cache
- Privacy blacklisting, redaction (API keys, cards, SSNs), ambiguity detection
- Two-tier retention (14d images, 90d text), 2GB storage cap, hourly cleanup
- FTS5 full-text search index on text_content, app_name, window_title
- SQLite schema: `sense_sessions`, `sense_captures`, `sense_app_text_quality`

**Daemon RPC API (complete):**
- `sense.status`, `sense.enable`, `sense.disable`, `sense.pause`, `sense.resume`
- `sense.now` (latest capture + state), `sense.today` (sessions + app breakdown)
- `sense.search` (LIKE-based text search, returns captures)
- `sense.apps` (app usage grouped by bundle ID, today/week range)
- `sense.timeline` (captures with from/to/limit, ordered by captured_at DESC)
- `sense.settings`, `sense.updateSettings`, `sense.clear`, `sense.stats`

**Preload bridge (complete):** All sense methods already exposed on `window.bond`.

**Renderer UI: Nothing.** Zero Vue components for Sense. Settings view has a basic enable/disable toggle.

**App routing:** `AppView` type is `'chat' | 'projects' | 'media' | 'collections' | 'journal'`. Sidebar has nav items for each. `ViewShell` pattern established.

---

## Inspiration & Research

### Screenpipe (most relevant, 16k+ stars)
Tauri + React. Bottom-docked DVR scrubber with density bars (flex row of vertical bars, height = capture density per time bucket). Three-tier frame loading (video seek → asset protocol → HTTP JPEG). Scroll-to-scrub with non-linear acceleration: `Math.pow(scrollIntensity / 50, 1.5) * zoomMultiplier`. Ctrl+Scroll zooms (0.25x–4x). Arrow keys step frame-by-frame (0ms debounce). Alt+Arrow jumps app boundaries. Adjacent frame preloading. Search highlight overlays on OCR text. AI chat panel with time-range context selection.

### Windows Recall (best UX, closed source)
Horizontal timeline grouped into active segments with visible idle gaps. Hover-preview before click-to-commit — cheap exploration. Prev/next buttons for sequential browsing. Search splits into "text matches" and "visual matches" with app filtering. Day navigation with segment summaries.

### ActivityWatch (Vue.js prior art)
`timeline-simple.ts`: Pure SVG strip (`viewBox="0 0 100 4"`). Events become proportionally-sized colored rectangles. Labels only on events >5% of duration. Hover darkens color. Also uses vis-timeline for swimlane multi-track views. Most relevant to our stack.

### OpenRecall (simplest implementation)
Range input slider + full screenshot. Proves the pattern works with minimal UI. Search returns a grid of cards with click-to-enlarge modals.

### Memento Native
Command palette as entry point (search-first, not browse-first). FTS5 + semantic search. Browser context enrichment via Apple Events.

---

## Decisions (from research)

1. **Layout: split view.** Timeline scrubber at bottom, capture viewer above. This is the proven pattern (Screenpipe, Windows Recall both use it). Not a sidebar — the timeline needs horizontal space.

2. **Timeline rendering: density bars.** A row of thin vertical bars whose height represents capture count per time bucket. Built with flexbox, each bar is a `<div>` with dynamic height. Colored by dominant app in that bucket. This beats a range slider (OpenRecall) because it communicates where activity happened at a glance.

3. **Hover preview.** Hovering the timeline shows a small tooltip-style preview (screenshot thumbnail + app name + time) before clicking to commit. Reduces exploration cost dramatically (Windows Recall insight).

4. **Scroll-to-scrub.** Mouse wheel on the timeline scrubs through time. Non-linear acceleration: zoomed out scrolls faster, zoomed in scrolls slower. Much more natural than click-only.

5. **Day view as default.** One day fills the timeline at default zoom. Day navigation with prev/next arrows. No infinite scroll — explicit day boundaries match how people think about their activity.

6. **No filmstrip row.** Too memory-heavy for the initial version. The density bars + hover preview provide enough visual orientation. Thumbnails only appear in the detail panel for the selected capture.

7. **Idle gaps as empty space.** Sessions map to active periods. Gaps between sessions render as empty/dimmed regions on the timeline. Makes activity patterns immediately visible.

8. **App colors: deterministic.** Hash bundle ID to HSL hue. Consistent across all views and sessions. Stored nowhere — computed on demand.

---

## Architecture

### 1. New AppView: `'sense'`

- Add `'sense'` to `AppView` type in `useAppView.ts`
- Add sidebar nav item (PhClockCounterClockwise icon — "rewind" fits the concept)
- New `SenseView.vue` component, wrapped in `ViewShell`

### 2. New RPC: `sense.capture`

Return a single capture by ID with the screenshot as base64 (if not purged). The existing `sense.timeline` returns metadata only — no image data.

```
sense.capture { id: string } → { capture: SenseCapture, image?: string (base64 JPEG) }
```

Also need `sense.sessions` to fetch sessions for a date range (for rendering idle gaps):

```
sense.sessions { from?: string, to?: string } → SenseSession[]
```

Update `sense.timeline` to support higher limits — current default of 50 is too low for a full day (a day at 15s intervals = ~3000+ captures during active use). Add pagination or bump limit.

### 3. Preload additions

```typescript
senseCapture: (id: string) => SenseCapture & { image?: string }
senseSessions: (from?: string, to?: string) => SenseSession[]
```

### 4. Composable: `useSense.ts`

```typescript
// State
const date = ref<string>(todayISO())       // selected day (YYYY-MM-DD)
const captures = ref<SenseCapture[]>([])    // all captures for selected day
const sessions = ref<SenseSession[]>([])    // sessions for selected day (for gap rendering)
const activeCapture = ref<SenseCapture | null>(null)
const activeCaptureImage = ref<string | null>(null)  // base64 of selected screenshot
const searchQuery = ref('')
const searchResults = ref<SenseCapture[]>([])
const appFilter = ref<string | null>(null)  // filter by bundle ID
const apps = ref<AppSummary[]>([])          // app breakdown for the day
const stats = ref<SenseStats | null>(null)
const loading = ref(false)

// Methods
loadDay(dateStr: string)      // fetches captures + sessions + apps for a day
selectCapture(id: string)     // fetches full capture with image
search(query: string)         // text search across all captures
setAppFilter(bundleId?)       // filter timeline to one app
nextDay() / prevDay()         // date navigation
jumpToCapture(capture)        // scroll timeline + select
```

### 5. Image Loading Strategy

Based on Screenpipe's three-tier loading insight: captures are stored as JPEG files on disk. The daemon reads them on demand via `sense.capture`. For the selected capture, fetch the image once and cache it in the composable. For hover previews, use a smaller/lower-quality version or debounce the fetch (200ms hover delay before requesting image). No preloading of adjacent frames in v1 — keep it simple.

---

## UI Components

### SenseView.vue (main container)

ViewShell wrapper. Two-zone vertical layout:

```
┌─────────────────────────────────────────┐
│  Header: ← Apr 5, 2026 → │ 🔍 search  │  ← SenseDayNav + search input
├─────────────────────────────────────────┤
│                                         │
│           Screenshot / Detail           │  ← SenseDetail (fills available space)
│                                         │
│                                         │
├─────────────────────────────────────────┤
│  App legend  ┃  ▁▃▅▇▅▃▁  ▁▂▅▇▅▂  ▁▃▅  │  ← SenseTimeline (fixed ~120px)
└─────────────────────────────────────────┘
```

### SenseTimeline.vue (the scrubber)

The core component. Fixed height (~120px) docked at the bottom of SenseView.

**Rendering approach:**
- Divide the day (00:00–23:59) into N equal time buckets (e.g., 1 bucket per minute = 1440 buckets, or adaptive based on container width — 1 bucket per pixel)
- Each bucket renders as a thin vertical bar. Height = capture count in that bucket (normalized to max). Color = dominant app's hue.
- Empty buckets (no captures, or between sessions) render as flat/invisible — creating natural gaps.
- A playhead line marks the currently selected capture's time.
- A hover indicator follows the mouse with a small preview tooltip above.

**Interaction:**
- **Click** on a bar → select nearest capture, load detail
- **Scroll wheel** on timeline → scrub through captures (non-linear: further from center = faster)
- **Keyboard:** Left/Right arrow → prev/next capture. Shift+Left/Right → jump to prev/next session boundary.
- **Hover:** 200ms delay, then show a mini preview card (thumbnail + app + time) floating above the hovered position

**Data:**
- Receives full day's captures + sessions from useSense
- Computes buckets client-side from capture timestamps
- App color: `hsl(hashCode(bundleId) % 360, 55%, 50%)` (light mode), adjusted lightness for dark mode

### SenseDayNav.vue (date navigation)

Inline in the ViewShell header toolbar. Compact.

- `← Apr 5, 2026 →` with prev/next day arrows
- Click the date label to open a date picker (native `<input type="date">` is fine for v1)
- Day summary shown as subtitle or tooltip: "342 captures, 4h 12m active, 8 apps"
- If navigating to a day with no data, show empty state with nearest-day suggestion (Screenpipe pattern)

### SenseDetail.vue (capture viewer)

Fills the main content area above the timeline.

- **With image:** Full screenshot scaled to fit (object-fit: contain), dark letterbox background
- **Purged:** Placeholder with ghost icon + "Screenshot purged — text preserved" message
- **No selection:** Empty state "Select a point on the timeline"

Below/overlaid on the screenshot:
- App name + icon (if available) + window title
- Timestamp (human-readable: "2:34 PM")
- Capture trigger badge (interval / app switch / clipboard)
- Ambiguous badge if flagged

Collapsible "Extracted text" panel below the screenshot — full OCR/accessibility text content. Useful for copying.

### SenseSearch.vue

Inline search in the header bar (not a separate view).

- Text input with search icon. Debounced 300ms.
- Results appear as a dropdown/overlay below the search input (BondFlyoutMenu pattern)
- Each result: app name, window title snippet, timestamp, text excerpt with query highlighted
- Click a result → `useSense.jumpToCapture()` → navigates to that day + selects capture on timeline
- Escape or blur closes results

### SenseAppLegend.vue (app color legend)

Small horizontal strip to the left of or above the timeline bars.

- Shows colored dots/chips for top apps active that day
- Click an app chip → toggles app filter on the timeline (filter mode: only that app's bars are full height, others dimmed)
- Click again → clears filter
- Deterministic colors matching the timeline bars

---

## Data Flow

```
User opens Sense tab
  → useSense.loadDay(today)
    → window.bond.senseTimeline(dayStart, dayEnd, 5000)
    → window.bond.senseSessions(dayStart, dayEnd)       // NEW RPC
    → window.bond.senseApps('today')
  → SenseTimeline renders density bars from captures
  → SenseAppLegend shows top apps

User hovers a timeline bar
  → 200ms delay → show preview tooltip (app + time, no image fetch)
  → If image fetch desired: window.bond.senseCapture(nearestCaptureId)

User clicks a timeline position
  → useSense.selectCapture(nearestCapture.id)
    → window.bond.senseCapture(id)  // fetches image base64
  → SenseDetail shows screenshot + metadata + text

User searches "figma mockup"
  → useSense.search('figma mockup')
    → window.bond.senseSearch('figma mockup', 50)
  → SenseSearch shows results dropdown
  → User clicks result → jumps to that day + capture

User clicks an app chip
  → useSense.setAppFilter('com.figma.Desktop')
  → SenseTimeline dims non-Figma bars, highlights Figma bars
  → Arrow key navigation skips non-matching captures
```

---

## Implementation Order

### Phase 1: Plumbing (no visible UI yet)
1. Add `sense.capture` RPC endpoint (single capture + base64 image)
2. Add `sense.sessions` RPC endpoint (sessions for date range)
3. Bump `sense.timeline` default limit to 5000, add ASC ordering option
4. Add preload bridge methods: `senseCapture()`, `senseSessions()`
5. Create `useSense.ts` composable

### Phase 2: Core view
6. Add `'sense'` to AppView type + sidebar nav item
7. `SenseView.vue` — ViewShell container with the three-zone layout
8. `SenseDayNav.vue` — date navigation in header
9. `SenseTimeline.vue` — density bar scrubber (the hard part)
10. `SenseDetail.vue` — capture viewer panel

### Phase 3: Interaction polish
11. Hover preview on timeline
12. Scroll-to-scrub with non-linear acceleration
13. Keyboard navigation (arrows, shift+arrows)
14. App color hashing + `SenseAppLegend.vue`
15. App filtering (click legend chip → filter timeline)

### Phase 4: Search
16. `SenseSearch.vue` — search input + results dropdown
17. Jump-to-capture from search results (cross-day navigation)

---

## Open Questions (resolved)

- ~~**Thumbnail filmstrip?**~~ No. Too memory-heavy. Density bars + hover preview are sufficient. Revisit if users request it.
- ~~**Zoom levels?**~~ Fixed day view for v1. Zoom is a v2 feature — adds significant complexity (bucket recalculation, partial-day rendering).
- ~~**Keyboard shortcut?**~~ No global shortcut for v1. Sidebar nav is sufficient. Keyboard shortcuts within the view (arrows, escape) are more important.
- ~~**Chat integration?**~~ Already exists via `autoContextInChat` setting. No mini-widget needed.
- ~~**Export?**~~ Out of scope for v1.
