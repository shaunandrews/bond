# Kill Sidebar Sections

Eliminate the sidebar's bottom nav sections (Projects, Collections, Operatives, Sense, Media) and the full-page views they navigate to. Everything that isn't chat lives in the right panel. Chat is always visible. The sidebar becomes a pure chat list.

---

## Why

The app currently has two overlapping navigation systems:

1. **Sidebar sections** — bottom of the left sidebar. Clicking one replaces the entire main area with a full-page view (ProjectsView, CollectionsView, OperativesView, SenseView, MediaView).
2. **Right panel icons** — top-right of the chat header. Clicking one opens a companion panel alongside chat (TodoView, ProjectPanelView, OperativePanelView, BrowserView).

Projects and Operatives exist in **both** systems with separate components. Todos is panel-only. Collections, Sense, and Media are full-page-only. There's no coherent mental model for what goes where or why.

The fix: one system. Chat is always the main area. Everything else is a right panel.

---

## Current state

### Sidebar nav items -> full-page views (to be removed)
| Sidebar item  | Component            | Lines | Has panel equivalent? |
|---------------|----------------------|-------|-----------------------|
| Projects      | ProjectsView.vue     | 308   | Yes -- ProjectPanelView (216 lines) |
| Collections   | CollectionsView.vue  | 268   | No |
| Operatives    | OperativesView.vue   | 219   | Yes -- OperativePanelView (369 lines) |
| Sense         | SenseView.vue        | 183   | No |
| Media         | MediaView.vue        | 177   | No |

### Right panel items (to be kept + expanded)
| Panel item    | Component              | Lines | Has full-page equivalent? |
|---------------|------------------------|-------|---------------------------|
| Todos         | TodoView.vue           | 833   | No |
| Projects      | ProjectPanelView.vue   | 216   | Yes -- ProjectsView |
| Operatives    | OperativePanelView.vue | 369   | Yes -- OperativesView |
| Browser       | BrowserView.vue        | --    | No |

### Key differences in duplicated views

**Projects -- significant gap.** ProjectPanelView is missing:
- ProjectWizard (create flow) -- needs a + button in panel header to trigger
- Archive flyout with unarchive -- needs `archivedProjects` prop
- Project context menu (archive/delete via `PhDotsThree` flyout)
- `remove` event
- `updateDeadline` event
- `archive` / `unarchive` events

ProjectPanelView has one feature ProjectsView doesn't: inline markdown file viewing. That stays.

**Operatives -- mixed.** OperativePanelView has the more complete *detail* view (inline event feed, streaming activity). But OperativesView has features the panel lacks:
- Filter tabs (All / Active / Done) via BondTab
- "Clear finished" button
- `clear` event
- Working directory + cost display in list items

The merged panel needs both the list-level features from OperativesView and the detail-level features from OperativePanelView.

---

## Design

### The sidebar becomes chat-only
- Remove the `<nav class="sidebar-nav">` block (lines 180-220) from SessionSidebar.vue
- Remove sidebar nav props: `mediaCount`, `projectCount`, `collectionCount`, `operativeRunningCount`
- Remove sidebar nav events: `@projects`, `@collections`, `@media`, `@sense`, `@operatives`
- Remove `activeView` prop -- sessions only highlight as active when they're the selected chat, and once all views are panels, chat is always the main view
- Remove associated CSS (`.sidebar-nav`, `.sidebar-nav-item`, `.media-count-badge`, `.running-badge`, `@keyframes pulse-badge`)
- The sidebar is now just: toolbar + chat list

### The right panel absorbs everything

The right panel is currently gated on `activeView === 'chat'`. Two guards must be removed first:

```ts
// App.vue line 142 -- remove the activeView check
const rightPanelOpen = computed(() => !rightPanelCollapsed.value && activeView.value === 'chat')
// becomes:
const rightPanelOpen = computed(() => !rightPanelCollapsed.value)

// App.vue line 157 -- same
const rightPanelHidden = computed(() => rightPanelCollapsed.value || activeView.value !== 'chat')
// becomes:
const rightPanelHidden = computed(() => rightPanelCollapsed.value)
```

Once the full-page views are gone and `activeView` is always `'chat'`, these guards are moot anyway. But they must be removed *before* the full-page views so there's no broken intermediate state.

Expand `RightPanelContent`:
```ts
type RightPanelContent = 'todos' | 'projects' | 'browser' | 'operatives' | 'collections' | 'sense' | 'media'
```

### Panel icons in the chat header

Current: 4 icons (Projects, Todos, Operatives, Browser). Adding 3 more (Collections, Sense, Media) makes 7, which is too many for individual icons.

**Approach: icon row + overflow menu.**

Always visible as icons (the 4 that exist today):
- Projects (PhCube)
- Todos (PhChecks)
- Operatives (PhRobot)
- Browser (PhGlobe)

Behind overflow menu (PhDotsThree):
- Collections (PhListBullets)
- Sense (PhClockCounterClockwise)
- Media (PhImages)

The overflow menu items show badges/counts to preserve the status indicators the sidebar nav had:
- Collections: item count
- Operatives (already visible as icon): running count with pulse animation
- Media: image count

This keeps the header clean while making everything accessible. Pinning/customization is a future enhancement.

### Merge duplicate components

**Projects -> ProjectPanelView absorbs ProjectsView features:**
- Add `archivedProjects: Project[]` prop
- Add events: `create`, `archive`, `unarchive`, `remove`, `updateDeadline`
- Add ProjectWizard trigger (+ button in panel toolbar)
- Add archive flyout (same pattern as SessionSidebar's archive flyout)
- Add project context menu (archive/delete) to detail view toolbar
- Keep existing inline markdown viewing

**Operatives -> OperativePanelView absorbs OperativesView features:**
- Add BondTab filter (All / Active / Done) to list view
- Add "Clear finished" button to list toolbar
- Add `clear` event
- Add working directory + cost to list items
- Keep existing inline detail view with streaming event feed

### Adapt existing views for panel width

**CollectionsView -> reuse directly at panel width.** CollectionsView (268 lines) has a list/detail pattern that already works as a vertical stack. Changes needed:
- Remove ViewShell wrapping (panels have their own toolbar pattern)
- Replace with BondToolbar + scrollable div (same pattern as OperativePanelView)
- Remove `insetStart` prop
- Tighten padding for panel density
- CollectionDetail sub-component is reused as-is
- Archive flyout and context menu are kept

**SenseView -> simplified panel adaptation.** The full SenseView has a density timeline bar (1440 minute-buckets) that needs substantial horizontal space. At panel width (260-360px), this is unusable. The panel version should be a simplified interface:
- Search bar at top (SenseSearch)
- Day navigation (SenseDayNav, compact variant)
- Vertical list of captures (thumbnail + app + time) instead of density bar
- Click capture to see detail in an expanded view within the panel
- Skip SenseTimeline and SenseAppLegend -- these are reference tools that work better at full width (consider a "pop out to full screen" button as a future enhancement)

**MediaView -> reuse directly at panel width.** MediaView (177 lines) is a CSS multi-column image grid (`columns: 180px`). At panel width, it naturally reflows to fewer columns. Changes needed:
- Remove ViewShell wrapping, replace with BondToolbar + scrollable div
- Remove `insetStart` prop
- Reduce column width threshold (`columns: 120px`) for tighter fit
- Keep existing double-click-to-open behavior

### BrowserView stays v-show

`BrowserView` currently uses `v-show` (not `v-if`) so webview tabs stay alive when switching to other panels (App.vue line 730). All other panel views use `v-if`. This must be preserved when adding the new panel views -- all new entries should use `v-if`/`v-else-if`.

---

## Implementation

### Phase 1: Ungate the right panel
1. Remove `activeView === 'chat'` guard from `rightPanelOpen` and `rightPanelHidden` computed properties in App.vue
2. Clean up `useAppView.ts` -- remove stale `'journal'` value from the `AppView` type

This is a one-line prerequisite that prevents broken intermediate states in later phases.

### Phase 2: Adapt views for panel width
3. Convert CollectionsView to panel layout: strip ViewShell, use BondToolbar + scroll div, tighten padding, keep archive flyout + context menu + CollectionDetail
4. Create SensePanelView.vue: search bar, compact day nav, vertical capture list (no density timeline), in-panel detail view
5. Convert MediaView to panel layout: strip ViewShell, use BondToolbar + scroll div, adjust column width

### Phase 3: Merge duplicate components
6. Absorb ProjectsView into ProjectPanelView:
   - Add `archivedProjects` prop
   - Add `create`, `archive`, `unarchive`, `remove`, `updateDeadline` events
   - Add ProjectWizard trigger in toolbar
   - Add archive flyout
   - Add project context menu
7. Absorb OperativesView into OperativePanelView:
   - Add BondTab filter (All / Active / Done) to list view
   - Add "Clear finished" button + `clear` event
   - Add working directory + cost to list items
8. Delete ProjectsView.vue
9. Delete OperativesView.vue
10. Delete OperativeDetail.vue (its functionality is already fully covered by OperativePanelView's inline detail)

### Phase 4: Expand the right panel
11. Update `RightPanelContent` type to include all 7 values
12. Add Collections, Sense, Media to the right panel's rendering chain in App.vue (all `v-if`/`v-else-if`, BrowserView stays `v-show`)
13. Wire up props and events for the 3 new panel entries (collections composable data, sense composable data, media loading)
14. Add PanelOverflowMenu to chat header toolbar -- PhDotsThree button with flyout showing Collections, Sense, Media with badge counts

### Phase 5: Kill sidebar sections and full-page views
15. Remove `<nav class="sidebar-nav">` block from SessionSidebar.vue
16. Remove sidebar nav props (`mediaCount`, `projectCount`, `collectionCount`, `operativeRunningCount`) and events (`@projects`, `@collections`, `@media`, `@sense`, `@operatives`) from SessionSidebar
17. Remove corresponding prop/event bindings on `<SessionSidebar>` in App.vue
18. Remove all full-page view blocks from the main panel in App.vue:
    - `<ProjectsView v-show="activeView === 'projects'">` block
    - `<CollectionsView v-show="activeView === 'collections'">` block
    - `<MediaView v-show="activeView === 'media'">` block
    - `<SenseView v-show="activeView === 'sense'">` block
    - `<template v-if="activeView === 'operatives'">` block (includes OperativeDetail + OperativesView)
19. Remove dead imports from App.vue: ProjectsView, CollectionsView, MediaView, SenseView, OperativesView, OperativeDetail
20. Remove `activeView` from SessionSidebar's props and the `activeView === 'chat'` checks on session active state (sessions are always active when selected, since chat is always visible)
21. Simplify or delete `useAppView.ts` -- if `activeView` is always `'chat'`, the composable is dead code. Remove the `AppView` type export and all imports. If any handlers still set `activeView` (e.g., `handleNewSession`, `handleSelectSession`, `handleProjectStartChat`, `handleTodoChat`), remove those assignments since they're no-ops now.
22. Clean up `activeView`-dependent logic throughout App.vue:
    - `handleNewSession()` sets `activeView.value = 'chat'` -- remove
    - `handleCreateSkill()` sets `activeView.value = 'chat'` -- remove
    - `handleTodoChat()` sets `activeView.value = 'chat'` -- remove
    - `handleProjectStartChat()` sets `activeView.value = 'chat'` -- remove
    - `handleSelectSession()` sets `activeView.value = 'chat'` -- remove

### Phase 6: Polish
23. Keyboard shortcuts:
    - Keep: `Cmd+Shift+B` (toggle right panel), `Cmd+Shift+K` (browser)
    - Add: `Cmd+Shift+P` (projects), `Cmd+Shift+O` (operatives)
    - Collections, Sense, Media are accessible via overflow menu (no shortcut needed for v1)
24. Overflow menu badges: show running operative count (pulse), collection count, media count
25. Right panel min-width per content type: browser 360px, sense 300px, others 260px (already partially implemented via the existing `rightPanelContent === 'browser' ? 360 : 260` ternary -- extend it)
26. Panel state memory: right panel should remember last-open content type (already does via localStorage `bond:right-panel-content`) and per-panel scroll position (optional, defer if complex)

---

## Files affected

### Delete
- `src/renderer/components/ProjectsView.vue` (308 lines)
- `src/renderer/components/OperativesView.vue` (219 lines)
- `src/renderer/components/OperativeDetail.vue` (absorbed into OperativePanelView)

### Major edits
- `src/renderer/App.vue` -- remove full-page views, remove activeView guards on right panel, expand right panel rendering, update header icons + overflow menu, remove dead `activeView` assignments, remove dead imports
- `src/renderer/components/SessionSidebar.vue` -- remove bottom nav block, remove nav-related props/events/CSS
- `src/renderer/components/ProjectPanelView.vue` -- absorb wizard, archive flyout, context menu, deadline editing, new props/events
- `src/renderer/components/OperativePanelView.vue` -- absorb filter tabs, clear action, working dir + cost in list
- `src/renderer/components/CollectionsView.vue` -- strip ViewShell, convert to panel layout pattern
- `src/renderer/components/MediaView.vue` -- strip ViewShell, convert to panel layout pattern
- `src/renderer/composables/useAppView.ts` -- simplify to the point of deletion

### New files
- `src/renderer/components/SensePanelView.vue` -- simplified Sense for panel width (search, day nav, capture list, inline detail)
- `src/renderer/components/PanelOverflowMenu.vue` -- the overflow menu for extra panel types with badge counts

### Minor edits
- `src/renderer/components/SessionCard.vue` -- remove `activeView === 'chat'` from active state check (always true now)
- `src/renderer/components/SessionItem.vue` -- same if applicable

### Preserved (no changes needed)
- `src/renderer/components/CollectionDetail.vue` -- reused by the converted CollectionsView
- `src/renderer/components/ProjectDetail.vue` -- reused by ProjectPanelView
- `src/renderer/components/ProjectWizard.vue` -- reused by ProjectPanelView
- `src/renderer/composables/useCollections.ts` -- data layer unchanged
- `src/renderer/composables/useSense.ts` -- data layer unchanged
- `src/renderer/components/SenseSearch.vue` -- reused by SensePanelView
- `src/renderer/components/SenseDayNav.vue` -- reused by SensePanelView
- `src/renderer/components/BrowserView.vue` -- unchanged, stays v-show

---

## What we're NOT doing
- Not changing the sidebar's chat list behavior (favorites grid, archive flyout, session cards)
- Not moving the browser -- it stays as a right panel
- Not removing any functionality -- just consolidating where it lives
- Not building panel pinning/customization yet (future enhancement)
- Not bringing the full Sense timeline/density bar into the panel -- it needs too much horizontal space. The panel gets a simplified capture list. A "pop out to full view" button could be a future addition.
- Not adding keyboard shortcuts for Collections, Sense, or Media (behind overflow menu is sufficient for v1)

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Panel width cramped for data-heavy views (CollectionDetail tables, Sense captures) | Medium | Allow panel resize wider (already supported). Design panel views to work at 260-600px. Test at minimum width. |
| 7 panel types behind one surface feels cluttered | Low | Overflow menu keeps header to 4 icons. Most users will use 2-3 panels regularly. |
| Losing sidebar status badges (running operatives, counts) | Medium | Replicate badges in overflow menu items. Running operative count also shows on the always-visible operative icon. |
| Sense panel without density timeline is a downgrade | Medium | The panel version focuses on search + browse, which is the more common use case. Consider "expand to full view" as a follow-up. |
| SenseView auto-refresh timer (30s interval) needs lifecycle management in panel context | Low | Panel views mount/unmount via v-if. The existing onMounted/onUnmounted lifecycle in SensePanelView handles this correctly -- timer starts on mount, clears on unmount. |
| BrowserView webview lifecycle breaks if accidentally changed to v-if | High | Comment in code already exists (line 729). Preserve v-show, add a test or more prominent comment. |
