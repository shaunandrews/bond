# Testing Plan

Ship every change with tests. Make the AI do it automatically. Catch regressions before they land.

---

## Current State

- **Vitest** configured with happy-dom + @vue/test-utils
- **20 test files**, **252 tests**, all passing in ~1.4s
- **135 source files** — roughly 15% have test coverage
- **Playwright** installed but unconfigured
- **No CI**, no git hooks, no coverage reporting
- CLAUDE.md has testing rules but nothing enforces them

### What's Covered

| Layer | Covered | Missing |
|-------|---------|---------|
| Daemon | `images`, `server`, `sense/privacy`, `sense/redaction`, `sense/storage` | `todos`, `sessions`, `projects`, `collections`, `db`, `settings`, `skills`, `operatives`, `parse-todo`, `agent`, `generate-title`, `generate-journal-meta`, `generate-journal-comment`, `sense/controller`, `sense/text-router`, `sense/worker` |
| Main | `agent` | `index`, `browser`, `sense`, `tray`, `quick-chat`, `window-router` |
| Renderer composables | `useChat`, `useAutoScroll`, `useJournal`, `useSessions` | `useProjects`, `useCollections`, `useOperatives`, `useOperativeEvents`, `useBrowser`, `useSense`, `useAccentColor`, `useAppView` |
| Renderer components | `ChatInput`, `MessageBubble`, `MarkdownMessage`, `QuickChat`, `SessionSidebar`, `ViewShell` (incl. sidebar toggle behavior), `BondPanelGroup`/`BondPanel`/`BondPanelHandle`, `FieldManual` | All embeds (`embeds/*.vue`), `CollectionDetail`, `CollectionItemDetail`, `CollectionsView`, `ProjectDetail`, `ProjectPanelView`, `OperativePanelView`, `SensePanelView`, `TodoView`, `EmbedRenderer`, `ArtifactFrame`, `JournalView`, `SessionCard`, `SessionPreview`, `ContextGauge`, `MarkdownViewer` |
| Renderer lib | `parseArtifacts` | `highlight` |
| Shared | — | `protocol`, `client`, `stream`, `session` |
| CLI | — | All 10 CLI modules |

---

## Phase 1 — Infrastructure (do first)

### 1.1 Coverage reporting

Install `@vitest/coverage-v8`. Add coverage config to `vitest.config.ts`:

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.{ts,vue}'],
  exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/main.ts', 'src/**/index.ts'],
  reporter: ['text', 'json-summary'],
  thresholds: {
    lines: 20,
    branches: 15,
  }
}
```

Add script to `package.json`:

```json
"test:coverage": "vitest run --coverage"
```

Note: `"test": "vitest"` already serves as watch mode.

### 1.2 Pre-commit hook

Add a git pre-commit hook that runs `vitest run`. If tests fail, the commit is rejected.

```bash
#!/bin/sh
# .git/hooks/pre-commit
npm run test:run --prefix "$(git rev-parse --show-toplevel)"
```

Simple. No dependencies. Catches regressions before they're committed.

### 1.3 Strengthen CLAUDE.md enforcement

Update the testing section to make rules unambiguous:

- Every new `.ts` file with logic gets a `.test.ts` sibling
- Every new composable gets unit tests
- Every new component with props, events, or user interaction gets component tests
- Every bug fix includes a regression test that would have caught it
- `npm run test:run` is the **final step** of any code change — always run it, never skip it
- When modifying existing code, check for an adjacent test file and update it to cover the change
- If a test file exists but doesn't cover the modified code path, add a test case

These aren't suggestions — they're the workflow. The AI follows them automatically on every task.

---

## Phase 2 — Unit Test Backfill (priority order)

### P0 — Daemon data layer

These are the SQLite CRUD modules. Bugs here corrupt user data. Each gets a test file that creates an in-memory DB, runs migrations, and exercises all exported functions.

| File | Test focus |
|------|------------|
| `daemon/db.ts` | Migration runs cleanly, WAL mode enabled, schema correct |
| `daemon/todos.ts` | CRUD, group assignment, project linking, filtering |
| `daemon/sessions.ts` | Create/update/delete sessions + messages, ordering |
| `daemon/projects.ts` | CRUD, resource add/remove, archive |
| `daemon/collections.ts` | Schema creation, item CRUD, filtering by field values |
| `daemon/settings.ts` | Get/set/delete, type coercion |

### P0 — Shared modules

Used by every layer. Type guards, protocol helpers, client utilities.

| File | Test focus |
|------|------------|
| `shared/protocol.ts` | JSON-RPC request/response/error construction, validation |
| `shared/client.ts` | Connection state, message serialization, reconnect logic |

### P1 — Daemon logic

Pure functions and stateful logic that's testable without heavy mocking.

| File | Test focus |
|------|------------|
| `daemon/parse-todo.ts` | Natural language parsing edge cases |
| `daemon/skills.ts` | Skill directory scanning, frontmatter parsing |
| `daemon/operatives.ts` | Spawn, cancel, event storage, concurrency queue limits |
| `daemon/generate-title.ts` | Title generation (mock the API call, test the prompt/parsing) |
| `daemon/generate-journal-meta.ts` | Journal metadata extraction (mock the API call) |
| `daemon/generate-journal-comment.ts` | Comment generation (mock the API call) |
| `daemon/sense/controller.ts` | State machine transitions |
| `daemon/sense/text-router.ts` | Routing logic, quality cache |
| `daemon/sense/worker.ts` | Queue processing, concurrency limits |

### P1 — Renderer composables

These are the remaining composables without tests. Use the existing `withSetup` helper pattern.

| File | Test focus |
|------|------------|
| `composables/useProjects.ts` | Fetch, create, archive, resource management |
| `composables/useCollections.ts` | Schema handling, item CRUD, filtering |
| `composables/useOperatives.ts` | Spawn, cancel, status polling |
| `composables/useOperativeEvents.ts` | Event loading, live append from notifications |
| `composables/useBrowser.ts` | Tab management, navigation commands |
| `composables/useSense.ts` | State subscriptions, timeline queries |

### P2 — Renderer components

Focus on components with meaningful interaction — not pure layout shells.

| Component | Test focus |
|-----------|------------|
| `EmbedRenderer.vue` | Correct embed type dispatch, prop forwarding |
| `ArtifactFrame.vue` | Sandbox behavior, postMessage handling |
| `CollectionDetail.vue` | Item rendering, field editing, status toggling |
| `CollectionItemDetail.vue` | Field display, editing, navigation |
| `CollectionsView.vue` | List rendering, selection, create/archive |
| `ProjectDetail.vue` | Resource list, todo integration |
| `ProjectPanelView.vue` | Panel list/detail, project selection |
| `TodoView.vue` | Check/uncheck, add, group display |
| `OperativePanelView.vue` | Operative list, status, spawn/cancel |
| `JournalView.vue` | Journal entry display, navigation |
| `ContextGauge.vue` | Context usage rendering |
| `embeds/*.vue` | Each embed renders correct data, handles empty state |

### P3 — CLI modules

Test arg parsing, output formatting, error handling. Mock the daemon socket.

| Module | Test focus |
|--------|------------|
| `cli/todo.ts` | Subcommand routing, flag parsing, output format |
| `cli/collection.ts` | Schema flag parsing, filter construction |
| `cli/project.ts` | Resource add/rm, archive |
| `cli/journal.ts` | Entry listing, date filtering |
| `cli/operative.ts` | Spawn args, cancel, status display |
| `cli/sense.ts` | Day queries, capture listing |
| `cli/browser.ts` | Tab commands, navigation |
| `cli/media.ts` | Media listing, output format |
| `cli/soul.ts` | Soul get/set |
| `cli/screenshot.ts` | Capture invocation |

### Skip

These have low ROI for unit tests:

- Pure presentational components (`BondButton`, `BondText`, `ThinkingIndicator`, etc.)
- Entry points (`main.ts`, `index.ts`, `settings-main.ts`, `viewer-main.ts`)
- Type-only files (`types/message.ts`, `shared/models.ts`, `shared/sense.ts`)
- `preload/index.ts` (thin contextBridge wrapper)
- Native binary wrappers (`sense/ocr.ts`, `sense/accessibility.ts`, `sense/helpers.ts`)

---

## Phase 3 — Playwright E2E Tests

End-to-end tests for the actual Electron app. These are slower, heavier, and more fragile than unit tests — but they catch integration bugs that unit tests miss entirely. Use them surgically for critical user flows.

### 3.1 Setup

Install `@playwright/test` (the test framework — `playwright` in devDependencies is only the browser binary package):

```bash
npm install -D @playwright/test
```

Create `playwright.config.ts` at the project root:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    trace: 'on-first-retry',
  },
})
```

Create `e2e/` directory for all E2E test files.

Add scripts to `package.json`:

```json
"test:e2e": "npm run build && playwright test",
"test:e2e:headed": "npm run build && playwright test --headed",
"test:e2e:debug": "npm run build && playwright test --debug"
```

E2E tests launch the built app (`./out/main/index.js`), so a build step is required.

### 3.2 Electron test harness

Playwright supports Electron natively via `electron.launch()`. Create a shared fixture:

```ts
// e2e/fixtures.ts
import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test'

type Fixtures = {
  app: ElectronApplication
  mainWindow: Page
}

export const test = base.extend<Fixtures>({
  app: async ({}, use) => {
    const app = await electron.launch({
      args: ['./out/main/index.js'],
      env: {
        ...process.env,
        BOND_TEST: '1',           // flag for test mode
        BOND_DB: ':memory:',      // don't touch real data
        BOND_SOCK: '/tmp/bond-test.sock',
      },
    })
    await use(app)
    await app.close()
  },
  mainWindow: async ({ app }, use) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
  },
})

export { expect } from '@playwright/test'
```

This launches Bond in an isolated test mode with an in-memory database so E2E tests never corrupt real user data.

### 3.3 Test mode support

Add `BOND_TEST` environment variable handling to the daemon and main process:

- **Daemon**: When `BOND_TEST=1`, use in-memory SQLite and a test socket path
- **Main process**: When `BOND_TEST=1`, skip auto-update checks, skip tray setup, use test socket
- **Renderer**: No changes needed — it talks to the main process the same way regardless

### 3.4 Critical E2E flows (P0)

These are the flows where integration bugs actually bite us:

| Test file | Flow | What it validates |
|-----------|------|-------------------|
| `e2e/session.spec.ts` | Create session → send message → see response stream → message persists after reload | Full IPC chain: renderer → main → daemon → agent → back |
| `e2e/sidebar.spec.ts` | Session list loads → create new → switch between sessions → delete session | Session CRUD through the real UI |
| `e2e/panels.spec.ts` | Open todo panel → add todo → check it off → open project panel → see todo linked | Panel navigation + cross-feature integration |
| `e2e/settings.spec.ts` | Open settings → change accent color → verify it applies → change model → verify persistence | Settings round-trip through all layers |

### 3.5 Secondary E2E flows (P1)

| Test file | Flow |
|-----------|------|
| `e2e/collections.spec.ts` | Create collection with schema → add items → filter → edit → delete |
| `e2e/browser.spec.ts` | Open browser tab → navigate → read content → close tab |
| `e2e/embeds.spec.ts` | Send message that produces embed → verify embed renders → interact with it |
| `e2e/quick-chat.spec.ts` | Trigger quick chat → type → send → verify response → dismiss |

### 3.6 E2E guidelines

- **Don't duplicate unit test coverage.** E2E tests verify integration, not logic. If a function is wrong, a unit test should catch it. E2E tests catch when correct functions are wired together incorrectly.
- **Keep them fast.** Target <30s per test. Use `BOND_TEST` mode to skip animations and delays where possible.
- **Retry once.** Electron E2E tests are inherently flaky. One retry is fine. Two retries means the test is bad.
- **Don't test the AI.** Mock the agent response in E2E tests. We're testing Bond's plumbing, not Claude's output.
- **Isolate state.** Every test gets a fresh in-memory DB. No test depends on another test's state.
- **E2E tests don't block commits.** They run separately via `npm run test:e2e`, not in the pre-commit hook. They're too slow for that. Run them before releases or as a manual check.

---

## Phase 4 — Ratcheting

Coverage thresholds increase as backfill progresses. Never let them decrease.

| Milestone | Lines | Branches | When |
|-----------|-------|----------|------|
| After infra setup | 20% | 15% | Phase 1 complete |
| After P0 backfill | 40% | 30% | Phase 2 P0 complete |
| After P1 backfill | 55% | 45% | Phase 2 P1 complete |
| Steady state | 60%+ | 50%+ | Ongoing |

These are floors. Real coverage will likely be higher. The thresholds just prevent regression.

---

## AI Workflow Integration

The goal: every code change ships with tests, automatically, without the user asking.

### What the AI does on every task

1. **Before coding** — check if a `.test.ts` file exists for the file being modified
2. **While coding** — write or update tests alongside the implementation
3. **After coding** — run `npm run test:run` and verify green
4. **If tests fail** — fix the code or the test, don't ship red

### What counts as "needs a test"

- New exported function → unit test
- New composable → unit test with `withSetup`
- New component with props/events/interaction → component test
- Bug fix → regression test that reproduces the bug first
- Modified existing code → update adjacent test file if one exists

### What doesn't need a test

- Type definitions and interfaces
- Re-exports and barrel files
- Pure presentational components (no logic, no events)
- Config files
- One-off scripts

### Operatives

When spawning operatives for coding tasks, include in the prompt:

> Write tests for all new functionality. Run `npm run test:run` before finishing. Do not complete the task if tests fail.

This makes testing automatic for background work too.

---

## Execution Order

1. **Now** — Phase 1: install coverage, add pre-commit hook, update CLAUDE.md
2. **Next** — Phase 2 P0: daemon data layer + shared module tests
3. **Then** — Phase 2 P1: daemon logic + remaining composables
4. **Then** — Phase 3: Playwright setup + P0 E2E flows
5. **Ongoing** — Phase 2 P2/P3 + Phase 3 P1 + ratcheting thresholds
