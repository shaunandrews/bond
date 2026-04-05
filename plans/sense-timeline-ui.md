# Sense Timeline UI

A new "Sense" tab in Bond's main view — a visual, scrubbable timeline of screen activity. Time Machine meets DVR: scrub through your day, see what you were doing, search for anything you saw.

---

## Current State

- Sense backend is solid: captures every 15s, event-driven on app switch/clipboard, OCR + accessibility text extraction, privacy blacklisting, two-tier retention (14d images, 90d text), 2GB storage cap
- CLI exposes: now, today, yesterday, search, apps, timeline
- Daemon has full RPC API (`sense.status`, `sense.now`, `sense.today`, `sense.search`, `sense.apps`, `sense.timeline`, `sense.stats`, etc.)
- **No renderer-side UI exists yet** — zero Vue components for Sense
- App already has the pattern: `AppView` type (`'chat' | 'projects' | 'media' | 'collections' | 'journal'`), sidebar nav, `ViewShell` wrapper

---

## Inspiration

- **[Screenpipe](https://github.com/screenpipe/screenpipe)** (16k+ stars) — DVR-style timeline scrubber. `TimeScrubber` component calculates target time from click position on a track. Event-driven captures (app switch, click, typing pause) rather than every second.
- **[Windrecorder](https://github.com/yuka-friends/Windrecorder)** — Screenshots every 3s, indexes on content change, auto-compresses to video. Activity stats with word clouds, timelines, light boxes, scatter plots.
- **[ActivityWatch](https://activitywatch.net/)** — Open source time tracker with a Vue.js web UI (`aw-webui`). Timeline view with horizontal color-coded bars per app, filterable by client/host. Good prior art for the "app lanes" concept.
- **[Rewind AI](https://rewind.ai/)** — Timeline with drag-to-select timeframe, app favicons as landmarks, search + filter by app/meeting. Keyboard-driven quick access.

---

## Architecture

### 1. New AppView: `'sense'`

- Add `'sense'` to `AppView` type in `useAppView.ts`
- Add sidebar nav item (`PhEye` or `PhClockCounterClockwise` icon)
- New `SenseView.vue` component, wrapped in `ViewShell` like every other view

### 2. Composable: `useSense.ts`

Manages all Sense state for the renderer:

- `captures` — reactive list of captures for current view range
- `activeCapture` — currently selected/hovered capture
- `dateRange` — `{ from, to }` controlling what's loaded
- `appFilter` — optional app name filter
- `searchQuery` — text search within captures
- `stats` — storage/capture counts
- `loading` — request state

Methods: `loadRange()`, `search()`, `selectCapture()`, `jumpToDate()`

Calls daemon RPC via `window.bond` bridge (need to expose sense methods in preload).

### 3. Preload Bridge

Expose sense RPC methods on `window.bond`:

- `senseStatus()`
- `senseNow()`
- `senseToday()`
- `senseSearch(query)`
- `senseApps(range)`
- `senseTimeline(from, to, limit)`
- `senseStats()`
- `senseCapture(id)` — **new** — fetch single capture with image

### 4. New RPC: `sense.capture`

Return a single capture by ID, including the image data (base64) if the image hasn't been purged. Needed for the detail/preview panel.

---

## UI Components

### SenseView.vue (main container)

- `ViewShell` wrapper with header toolbar
- Three-zone layout: header (date nav + search), timeline area, detail panel

### SenseTimeline.vue (the scrubber)

The core piece. Horizontal time axis for the selected day.

- **App lane bars**: stacked horizontal bars colored by app, showing active periods
- Capture dots/markers along the timeline at each capture point
- Click/drag to scrub through time — updates detail panel
- Hover shows tooltip with app name + time
- Gaps where user was idle shown as empty space
- Keyboard: arrow keys to step between captures, shift+arrow to jump sessions
- App colors: deterministic hash of bundle ID → hue, consistent across sessions

### SenseDayNav.vue (date navigation)

- Date picker / prev-next arrows to navigate between days
- Day summary: total active time, top apps, capture count
- Week overview strip: 7 small bars showing relative activity per day, click to jump

### SenseDetail.vue (capture detail)

- Screenshot (if available) or placeholder when purged
- App icon + name + window title
- Timestamp
- Extracted text content (collapsible)
- "Purged" badge when image is gone but text remains

### SenseSearch.vue

- Search input querying extracted text across all captures
- Results as capture cards with snippet highlighting
- Click result → jumps timeline to that point

### SenseApps.vue (app breakdown panel)

- Sidebar or collapsible panel showing app usage for selected day/range
- Color-coded bars matching timeline colors
- Click an app to filter timeline to just that app

---

## Visual Design

- Timeline scale: 1 day fits in ~800px at default zoom, zoomable
- Purged captures: faded/ghosted markers with text icon
- Idle gaps: subtle striped or dimmed areas
- Dark mode native — Bond color tokens throughout
- Optional thumbnail filmstrip row below the main timeline (lazy-load visible range only)

---

## Data Flow

```
User navigates to Sense tab
  → useSense.loadRange(today)
    → window.bond.senseTimeline(from, to)
    → window.bond.senseApps('today')
  → Renders SenseTimeline with capture markers + app bars

User clicks a capture marker
  → useSense.selectCapture(id)
    → window.bond.senseCapture(id)  // fetches image + full text
  → SenseDetail shows screenshot + metadata

User searches "error message"
  → useSense.search('error message')
    → window.bond.senseSearch('error message')
  → SenseSearch shows results, click jumps to capture
```

---

## Implementation Order

1. Preload bridge + `sense.capture` RPC endpoint
2. `useSense.ts` composable
3. `SenseView.vue` + `AppView` registration + sidebar item
4. `SenseTimeline.vue` (core scrubber — most complex piece)
5. `SenseDetail.vue` (capture preview)
6. `SenseDayNav.vue` (date navigation)
7. `SenseSearch.vue`
8. `SenseApps.vue` (nice-to-have, lower priority)

---

## Open Questions

- **Thumbnail filmstrip**: render a row of small screenshots below the timeline? Cool but memory-heavy. Could lazy-load visible range only.
- **Zoom levels**: day / half-day / hour? Or fixed day view with horizontal scroll?
- **Keyboard shortcut**: `⌘+Shift+S` to open Sense tab?
- **Chat integration**: should Sense show a mini-widget in the chat view (e.g. "you were just in Figma for 2 hours")?
- **Export**: should users be able to export a day's activity as a report?
