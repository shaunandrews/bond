# Bond — Development Instructions

## Commands

```bash
npm run dev            # Build daemon, then launch the Electron app with renderer hot-reload
npm run build          # Full build: electron-vite (main/preload/renderer) + daemon (esbuild) + native helpers
npm run build:daemon   # Bundle the daemon only → out/daemon/main.mjs (esbuild)
npm run build:web      # Build the browser bundle for remote (LAN) access → out/web (vite.web.config.ts)
npm run build:cli      # Bundle bin/bond CLI subcommands → out/cli/*.js (esbuild)
npm run build:native   # Compile the Obj-C Sense helpers → out/daemon/bin/sense/ (macOS only)
npm run test:run       # Run the whole test suite once
npx vitest run src/renderer/composables/useChat.test.ts   # Run a single test file
npx vitest run -t "streams thinking deltas"               # Run tests matching a name
npx vue-tsc --noEmit   # Typecheck the project incl. .vue call sites (no lint tooling is configured)
```

The daemon is a **separate long-lived process**, not part of the Vite dev server. `npm run dev` hot-reloads the renderer but **not** the daemon — after changing anything under `src/daemon/` or `src/shared/`, rebuild and restart it. Skills are cached at daemon startup, so new or edited skills also require a daemon restart. **Web client changes (`src/renderer/web/`) need NO daemon restart** — run `npm run build:web` and refresh the browser; the daemon serves `out/web` from disk per request. Use the `bin/bond` CLI to manage it during development:

```bash
bin/bond status          # Who is serving (via GET /health on the socket), strays, bundle freshness
bin/bond dev             # Stop daemon, rebuild it, then run electron-vite dev
bin/bond rebuild daemon  # Rebuild daemon, then supervised restart — after daemon/shared changes
bin/bond restart         # Supervised restart (launchctl kickstart) without rebuilding
bin/bond log             # Tail ~/.bond/daemon.log
```

`bin/bond start` runs the daemon under **launchd supervision** (`~/Library/LaunchAgents/com.bond.daemon.plist`, `KeepAlive`/`SuccessfulExit=false`): a crash or stray kill (nonzero exit) resurrects within ~5s and remote clients auto-reconnect, while voluntary exits stay down. `bin/bond stop` boots the agent out AND kills every daemon process, so an intentional stop stays stopped. `bin/bond restart` is safe to run from inside a Bond conversation: launchd completes the restart even though the calling bash process dies with the daemon.

**Single-instance enforcement** lives in `src/daemon/lifecycle.ts`, never in pid files (a pid file can only name one process — it once hid fifteen zombie daemons). Three layers: (1) startup **claim** — socket takeover is serialized through an O_EXCL start lock and gated on a live-connection probe, so a second starter bows out (exit 0) and only a provably dead socket file is ever unlinked; (2) **watchdog** — the daemon remembers the bound socket file's dev+ino and exits if the path vanishes or changes, so an orphaned daemon can never linger; (3) **health** — `GET /health` on the unix socket reports the serving pid and the loaded bundle's mtime, which `bin/bond status` compares against `out/daemon/main.mjs` on disk to flag a stale daemon. Tooling that needs "is a daemon running" must probe the socket (the Electron main process does) or enumerate exact command lines, never read `daemon.pid`.

## Testing

Bond uses **Vitest** with **happy-dom** and **@vue/test-utils** for testing.

```bash
npm run test:run      # single run
npm test              # watch mode
npm run test:coverage # with coverage report
```

Test files live next to their source: `useChat.ts` → `useChat.test.ts`, `ChatInput.vue` → `ChatInput.test.ts`.

### Rules

- **Every new `.ts` file with logic gets a `.test.ts` sibling.**
- **Every new composable gets unit tests.**
- **Every new component with props, events, or user interaction gets component tests.** Pure presentational components (no logic, no events) can skip tests.
- **Every bug fix includes a regression test** that would have caught it.
- **`npm run test:run` is the final step of any code change** — always run it, never skip it.
- **When modifying existing code**, check for an adjacent test file and update it to cover the change.
- **If a test file exists but doesn't cover the modified code path**, add a test case.
- **Composable tests** use a `withSetup` helper to run composables in a Vue app context. Inject mock `ChatDeps` instead of relying on `window.bond`.
- **Component tests** use `mount` or `shallowMount` from `@vue/test-utils`. Assert on emitted events, rendered text, and class presence — not computed styles (happy-dom doesn't process Tailwind).
- **Daemon data layer tests** create an in-memory SQLite database, run migrations, and exercise all exported functions.
- Test config is in `vitest.config.ts` (separate from `electron.vite.config.ts`). Coverage uses `@vitest/coverage-v8`.
- A **pre-commit hook** runs `vitest run` — commits are rejected if tests fail.

## Architecture

Bond uses a daemon architecture. The renderer never talks to Pi (the agent runtime) directly.

```
Renderer (Vue) → Electron IPC → Main Process → WebSocket over Unix socket (JSON-RPC 2.0) → Daemon → Pi → model provider
```

The daemon runs an HTTP + WebSocket server (`ws`) bound to the Unix socket `~/.bond/bond.sock`. `BondClient` (`src/shared/client.ts`) is the shared WebSocket client used by both the main process and the CLI.

**Remote access**: the daemon also listens on TCP `0.0.0.0:3113` (`remote.port` setting; port reserved via Port Keeper), serving the `out/web` browser bundle over HTTP and the same JSON-RPC WebSocket protocol. Browsers on the LAN pair via a URL/QR from Settings → Remote access whose `#t=…` fragment carries a persistent token (`remote.token` setting); the WebSocket auth gate plus a same-origin upgrade check are the security boundary. The web client (`src/renderer/web/`) reuses the renderer components with a browser `window.bond` shim over a native WebSocket. Live multi-device sync rides on four chunks: `turn_start` (mirrors the sender's user message + activity ids on other clients), `approval_resolved` (flips pending approval prompts everywhere), `question_resolved` (flips pending `ask_user_question` cards everywhere, including answers sent from `bond ask`), and `edit_mode_changed` (mirrors the global permissions mode). The renderer drops turn-scoped chunks whose `turnId` it doesn't own — a straggler racing a cancel can't mint orphan activity rows. **The web client runs in an insecure context** (plain http on a LAN IP) — secure-context-only APIs (`crypto.randomUUID`, `navigator.clipboard`, service workers) are undefined there; any renderer code the web client can reach needs fallbacks (`uid()` in `useChat.ts` and `lib/clipboard.ts` are the pattern). All agent work runs through **Pi** (`@earendil-works/pi-coding-agent`), which resolves Bond's capability tiers against the user's connected subscription — Bond never calls a provider API directly. Pi session transcripts persist as JSONL under `~/Library/Application Support/bond/pi/sessions/`.

### Daemon (`src/daemon/`)

Standalone Node.js WebSocket server on `~/.bond/bond.sock`. Manages agent queries, sessions, and settings. Persists to SQLite at `~/Library/Application Support/bond/bond.db`.

| File | Purpose |
|------|---------|
| `main.ts` | Entry point — claims the socket, starts servers, watchdog + signal handling |
| `lifecycle.ts` | Single-instance enforcement — socket claim under a start lock, orphan watchdog, `/health` payload |
| `wire-debug.ts` | Wire-level tool visibility — logs every model request's tool manifest (fetch + WebSocket, zstd-aware) |
| `server.ts` | WebSocket server with thin JSON-RPC 2.0 dispatch (`bond.*`, `session.*`, `image.*`, `settings.*`, `skills.*`, `sense.*`, `collection.*`, `web.*`) — turn lifecycle lives in `turns.ts` |
| `turns.ts` | Turn runner — serialized send lifecycle (a new send atomically aborts the running turn), active-turn ownership, broadcast/Sense transport seam |
| `approvals.ts` | The single pending-approval registry — `requestId` resolves, `turnId` scopes bulk clears; clients reconstruct pending prompts from persisted activity rows (no replay) |
| `questions.ts` | The single pending-question registry for `ask_user_question` — same shape as `approvals.ts` (`questionId` resolves, `turnId` scopes bulk clears), plus the `PendingQuestion` snapshot `question.pending` serves to the CLI |
| `agent.ts` / `pi/runtime.ts` | Builds Bond context, runs Pi sessions, streams chunks, parks tool approvals via `approvals.ts` |
| `pi/runtime.ts` | Pi session lifecycle, event streaming, edit-mode → tool/permission mapping, Bond memory tool registration, tier resolution, Pi OAuth |
| `memory/service.ts` | Serialized automatic observer persistence + epoch observer/reflector hooks; `enqueueMemoryTask` runs deferred work (incl. epoch-rollover hooks) on the same queue so it never blocks a send. **Validation failures never fail a run** — they degrade the record and the marker still advances; only a `model.generate` throw (transport) propagates. Also owns `recordToolEventArtifacts` (deterministic artifact capture) and `scheduleEpochReflection` (reflection's own cadence, since rollover is now a backstop) |
| `memory/ledger.ts` | The `memory_runs` table + `getMemoryHealth()` — every observer/reflector run, including transport failures, leaves a row. The single read behind `memory.health`, `bond memory status`, and the `memory_status` tool |
| `memory/artifacts.ts` | `workingPatchFromToolEvent` — pure detection rules mapping a `tool_execution_end` to a working-memory patch (library/file writes, `SKILL.md` reads, second-reads, Linear issue keys). No model in the path |
| `memory/tools.ts` | Bond-owned Pi tools for memory status/search/recall/history and explicit remember/update/forget |
| `memory/store.ts` | Searchable memory CRUD, FTS (OR-joined via the shared `fts.ts` builder), and relational source-message provenance |
| `memory/core-memory.ts` | Bounded persistent Core memory in `memory/core.json` |
| `web/tools.ts` | Bond-owned Pi tools `web_search` + `fetch_content` — keyless, zero-config web access with a 15-min cache and polite batch spacing |
| `web/broker.ts` | Render broker — parks tool promises, sends `web.requestRender` to the app, resolves on `web.renderReady`; errors clearly when no app is connected |
| `web/extract.ts` | DuckDuckGo SERP parsing (linkedom) and page → markdown extraction (Readability + Turndown) over app-rendered HTML |
| `questions/tools.ts` | The `ask_user_question` Pi tool — mints daemon-owned option ids, emits the `user_question` chunk, parks the turn on `questions.ts`'s registry until answered, resumed, or the turn is cleared |
| `desk/signature.ts` | Resource signatures + **the redaction boundary**. Sense only redacts *extracted* text; `window_title` is raw at trigger time. Desk transmits and persists titles/paths, so nothing leaves this module without passing `redact()`. Volatile badges/counters/clocks are stripped so `Inbox (3)` and `Inbox (7)` are one resource; the signature is an opaque hash so a suppression never carries a captured title |
| `desk/store.ts` | Threads, blocks, segments, and the `desk_runtime` singleton — the only place snake_case rows become `shared/desk.ts` types. `attributed_thread_id` is a **derived cache** (Phase 2): `desk_labels` holds every interpretation (matcher/model/user) and `desk/labels.ts` re-derives the cache when the rule generation (`rules_version`) bumps. A **user** label is frozen and never re-derived; matcher and model labels do — so correcting a rule is retroactive, but never rewrites what the user set |
| `desk/labels.ts` | Derived attribution (Phase 2) — `desk_labels` (one interpretation row per matcher/model/user), `recordLabel`, `deriveAttribution` (the authority order: user frozen > confirmed matcher > model > unconfirmed matcher never overturns a model label), and `rederiveStale` (the bounded background re-derivation sweep on the worker). A label-less segment is preserved, never wiped |
| `desk/matchers.ts` | The deterministic fast path and **the authority matrix**. `confirmed = 0` is an inferred one-resource attribution; `confirmed = 1` is a user-approved pattern. `writeInferredMatcher` cannot mutate a confirmed row, steal a pattern owned by another thread, or ever set `confirmed = 1`; there is deliberately no generic `upsertMatcher`. Also owns three-strike suppressions, checked **before** an unconfirmed matcher resolves so "No" changes behaviour rather than hiding the next question |
| `desk/merge.ts` | Thread merge in one transaction. Only `desk_suppressions` can collide (its PK includes `thread_id`): fold to `max(count)`, later expiry, `permanent = a OR b` — a merge must never *weaken* negative evidence. `desk_matchers` cannot collide; its UNIQUE excludes `thread_id`, so one pattern has exactly one owner |
| `desk/segmenter.ts` | Sense captures → segments → blocks, **no model call**. Owns the two-condition eligibility gate (survived-the-blacklist-recheck + a 10s age floor so an out-of-order capture is never leapfrogged), `presence_seconds` derived as `min(gap, 2 x captureInterval)` from the **user's configured** interval, and temporal smoothing over a rolling window of *time* rather than a count of observations |
| `desk/inference.ts` | The slow path — every pending unknown collapsed into ONE 200–500-token request via `runPiTextPrompt(prompt, 'fast')`. Strict-and-accumulating parse (a bad line is dropped with a reason, never thrown), at most one new thread per batch, redaction re-applied at assembly because existing Sense rows are raw, and a hard six-immediate-calls-per-hour ceiling |
| `desk/questions.ts` | The Ask lifecycle under one persisted ten-minute budget (`last_assertion_at`, so a restart can't reset it). Rejecting is a real state change — drop the unconfirmed matcher, clear the segment attributions, restore the block, suppress the pairing. Silence auto-accepts **this block only** and teaches nothing |
| `desk/retention.ts` | The Desk sweep, riding Sense's `textRetentionDays` cutoff and keyed to Desk timestamps (not capture links) so it is correct in either order. Edited notes graduate onto the thread before their block expires; suppressions and confirmed patterns survive, their captured examples do not |
| `desk/today.ts` | The idempotent Today collection. **`issue_prefix` has no uniqueness constraint**, so `ensureToday` reconciles rather than assumes: adopt the collection the setting names (or the oldest), strip `TODAY` from the others, never mint a third — two claimants would make `listReferences()` serve two items for one `TODAY-n` key |
| `desk/notes.ts` | Re-entry note generation at departure — the last 30 minutes of linked text only, redacted at assembly AND before persistence, nothing stored on a redaction hit. A user edit wins even if it lands mid-flight |
| `desk/service.ts` | The RPC-facing facade + the `desk.changed` broadcast. Reassignment is optimistic and confirms a durable rule **only** when a concrete pattern is supplied; a generic bundle (Chrome, Terminal, Finder, Slack, Code) is refused out loud |
| `desk/worker.ts` | Two loops on one serialized queue — 2s segmentation and a 15-minute inference sweep. No scheduler: a `setInterval`, matching the hourly retention sweep |
| `desk/stats.ts` | The instrumentation `bond desk stats` reads — calls, tokens, immediate-vs-swept, cache hit rate, unknown-resource latency. Without it the Phase 2 dogfood produces an impression instead of a decision |
| `desk/tools.ts` | The `open_desk` Pi tool. Emits the `open_desk` chunk; reports Sense-disabled and back-fill-pending states honestly instead of opening an empty panel. Available in every edit mode (it reveals a panel and reports state — no workspace reach) |
| `mcp/manager.ts` | Daemon-lifetime MCP connection registry — lazy connect, warm client reuse across turns, `tools/list` cache (invalidated by `list_changed` and on reconnect), idle disconnect, per-server error containment, promoted-tool schema prefetch (timeout-bounded), `shutdownMcp()` on the daemon exit path |
| `mcp/client.ts` | One MCP server connection over the official `@modelcontextprotocol/sdk` — StdioClientTransport or StreamableHTTPClientTransport; resolves `keychain:` references just before connecting; keeps the last 4k of stderr (where a stdio server reports auth trouble) |
| `mcp/config.ts` | `McpServerConfig` CRUD over the settings KV row `mcp.servers` (stdio + http, never a secret) + policy writes + the Context A8C preset |
| `mcp/policy.ts` | The trust policy and `decideMcpCall` — the ONE gate both the proxy and promoted tools pass through (allow / ask / block per trust × edit mode × human-confirmed tool class). Server `readOnlyHint`/`destructiveHint` annotations only pre-fill a suggestion; they are supplied by the same third party being judged, so they never classify anything themselves |
| `mcp/keychain.ts` | macOS Keychain secret store via the `security` CLI (injected runner, never a shell). Config holds `keychain:<ref>` references; values resolve at connect time and are never returned over RPC |
| `mcp/tools.ts` | The `mcp` proxy Pi tool (`search`/`describe`/`call`) plus any user-promoted tools registered as first-class `mcp__server__tool` Pi tools. Both paths run through `decideMcpCall` |
| `mcp/content.ts` | MCP result → text: content-block flattening, 20k truncation cap, image/audio/binary-resource placeholders |
| `remote.ts` | Remote (LAN) access server — TCP listener on `0.0.0.0:3113` serving the `out/web` bundle + WebSocket RPC gated by the persistent pairing token (`remote.token`), same-origin upgrade check, `remote.status` RPC |
| `pi/model.ts` | Capability-tier → concrete-model resolution (`pickModel`/`selectModel`) shared by the main turn and standalone agent sessions (extracted so agents don't import runtime.ts) |
| `agents/tools.ts` | The `consult_agent` Pi tool — Bond's doorway to the specialist roster — plus `buildAgentRosterPrompt` (the "Available agents" system-prompt section, generated per turn so a new definition needs no runtime wiring). Available in every edit mode because agents are read-only |
| `agents/definition.ts` | AGENT.md parsing — frontmatter (scalars, inline lists, one-level maps), `## verb:` section splitting, validation. Bundled agents go through this exact parser, so built-in and user definitions can't diverge |
| `agents/registry.ts` | The roster — bundled definitions plus `~/.bond/agents/<name>/AGENT.md` (a user file overrides a bundled agent of the same name). Invalid definitions surface as `problems`, never silent drops |
| `agents/run-agent.ts` | Generic agent session runner — isolated read-only Pi session (`read`/`grep`/`find`/`ls` + granted web tools), in-memory persistence, SSE, `thinkingLevel`, leash timer + parent-abort; returns only the final report text |
| `agents/prompt.ts` | The shared agent spine (read-only rules, evidence-last anti-anchoring, report contract) + doctrine + the invoked verb's workflow + user instructions |
| `agents/evidence.ts` | Evidence runners — `native` (Bond code, bundled-only) and `shell` (definition commands). Shell commands run only after one-time user approval keyed by command hash; a failed/denied/timed-out runner is evidence, never a consult failure |
| `agents/context-docs.ts` | Resolution for an agent's declared context docs (root → `.agents/context/` → `docs/`, stops at git root/home) — mirrors Impeccable's convention, doc names come from the definition |
| `agents/service.ts` | RPC-facing roster service — `agents.list`/`agents.updateSettings`/`agents.revokeRunner` |
| `agents/builtin/` | Bundled definitions as AGENT.md strings: `felix.ts` (design consultant; doctrine distilled from Impeccable, Apache-2.0, attributed) and `q.ts` (coding consultant; shell evidence runners + patch contract) |
| `design/detector.ts` | Pinned `npx impeccable detect --json` wrapper — Felix's native detector runner, with honest degradation (unavailable/timeout/error) |
| `design/migrate.ts` | Migration inventory — Felix's native migrate runner: scans literals in style contexts, clusters near-duplicates, maps clusters onto tokens (DESIGN.md frontmatter + CSS custom props) into exact/near/none buckets with Impeccable's tolerances |
| `imagegen.ts` | Bond glue for the bundled `pi-codex-image-gen` Pi extension (`codex_generate_image` — gpt-image-2 via the ChatGPT/Codex subscription already connected in Pi, no API key). Gates the tool on an `openai-codex` OAuth credential, captures generated images into the Bond image store, emits `generated_image` stream chunks, and strips base64 from activity previews. The package's disk writes and install telemetry are disabled via env defaults in `main.ts` |
| `onboarding.ts` | First-run detection, transcript intro seeding, and the staged interview → panel-tour flow (`pending` → `education` → `completed`). Serves stage-specific system-prompt sections and Pi tools: `complete_onboarding` (closes the interview, seeds the soul, returns the tour script), `complete_tour`, `show_panel` (opens a side panel via a `show_panel` stream chunk), and `enable_sense`. The interview and tour are the real agent — no scripted flow |
| `sandbox.ts` | New-user sandbox: swaps the daemon's data dir to a fresh empty directory (and back) so the real app runs a genuine first-run without touching real data |
| `sessions.ts` | SQLite CRUD for sessions and messages |
| `collections.ts` | Collections + items CRUD (SQLite). All writes are validated through the shared field registry (`shared/fields.ts`): schemas via `validateSchema` on create/update, item data via `coerceItemData` (add applies defaults + requires primary; update touches only incoming keys, `null` clears). Failures throw `CollectionValidationError` → `RPC_VALIDATION_ERROR` (-32000) with `data.errors` and a message naming the field + allowed values. Item display numbers come from a per-collection `next_display_number` counter (never reused, transactional); `issue_prefix` (2-6 uppercase letters) makes items referenceable as `PREFIX-n`; `listReferences()` serves the whole reference index in one call |
| `debriefs.ts` | Session debrief storage (SQLite) |
| `generate-debrief.ts` | Auto-generates session debriefs (summary + topics) |
| `images.ts` | Image storage — save/get/delete files + `images` table CRUD. Every save/delete also upserts/deletes a mirror row in `assets` (kind `'media'`, same id) so Library stays in sync — `images` remains the sole byte/id authority; nothing else writes to it |
| `library.ts` | Library data layer — the `assets` table (documents + a media mirror of `images`) and the `asset_references` join table linking assets to collection items. Documents own their bytes under `getLibraryDir()` (`library/<id><ext>`, mirrors `images/` exactly); `deleteAsset` deletes the file itself for documents or delegates to `images.ts`'s `deleteImage` for media, whose cascade (`ON DELETE CASCADE` on `asset_references`) is what keeps reference integrity a SQL-level guarantee rather than app-level cleanup |
| `db.ts` | Database init, migrations, WAL mode; `memory/ledger.ts` and `transcript.ts` own their own lazily-ensured tables (`memory_runs`, `messages`/`epochs`/`turns`). An UNREADABLE db is quarantined (renamed `.corrupt-<ts>`, Pi sessions/images untouched) — only a readable stale-version db takes the clean-cutover wipe. `transcript.ts` owns the `messages` table shape; `APP_SCHEMA_VERSION` stays pinned (bumping it IS the wipe) — schema evolves via in-version migrations |
| `fts.ts` | `buildMatchQuery` — safe FTS5 MATCH construction (phrase extraction with sanitized interiors, token extraction, quote-doubling, optional prefix, `and`/`or` mode) shared by transcript search, memory search, and `sense.search` |
| `settings.ts` | Key-value settings storage (soul, model, accent color) + typed accessors (`getSenseSettings`/`setSenseSettings`) |
| `paths.ts` | Data directory resolution |
| `index.ts` | Daemon library exports |
| `skills.ts` | Skill scanning from ~/.bond/skills/ |
| `sense/controller.ts` | Sense state machine (disabled/armed/recording/idle/paused/suspended) |
| `sense/presence.ts` | Idle detection via `ioreg -c IOHIDSystem` polling |
| `sense/window-detector.ts` | App/window polling via `bond-window-helper` native binary |
| `sense/clipboard.ts` | Clipboard mirroring via async `pbpaste` polling |
| `sense/privacy.ts` | Blacklist checking + ambiguity detection |
| `sense/accessibility.ts` | Accessibility tree extraction via `bond-accessibility-helper` |
| `sense/ocr.ts` | OCR extraction via `bond-ocr-helper` (max 2 parallel) |
| `sense/text-router.ts` | Accessibility vs. OCR routing with per-app quality cache |
| `sense/redaction.ts` | Security redaction (API keys, tokens, cards, SSNs) |
| `sense/worker.ts` | Queue-based text extraction worker |
| `sense/storage.ts` | Retention enforcement, auto-cleanup, storage stats |
| `sense/helpers.ts` | Native binary path resolution |

### Main Process (`src/main/`)

Electron main process. Spawns daemon if not running, creates window, proxies all IPC to the daemon via `BondClient`. On daemon restart it reconnects the **same** `BondClient` instance in place (the auth token is read through a provider on every attempt), so registered push listeners — chunk streaming, Sense, web renders, tray — survive `bin/bond rebuild daemon` without an app relaunch. Builds the native application menu, including **Bond → Run/Exit New-User Simulation** (⌘⌥N) which toggles the daemon's sandbox data set and reloads the window — the real app then boots into a genuine first-run. In packaged mode (`app.isPackaged`), resolves the daemon from `process.resourcesPath/daemon/`, finds Node.js via login shell + well-known paths, and resolves the full user PATH (login shell + fallback) so the daemon can find user-installed binaries like `studio`. Also handles Sense screenshot capture (`src/main/sense.ts` — `desktopCapturer` + `NativeImage.toJPEG`), the web render host (`src/main/web.ts` — a persistent hidden `BrowserWindow` that serves the daemon's `web.requestRender` requests so `web_search`/`fetch_content` get real-Chromium rendered HTML with no API keys), tray indicator (`src/main/tray.ts`).

### Preload (`src/preload/index.ts`)

Exposes `window.bond` via `contextBridge`. The 130 pure daemon proxies come from `buildDaemonSurface` in `src/shared/bond-surface.ts` riding ONE generic `bond:rpc` IPC channel (allowlisted against `RPC_METHOD_NAMES` in main); the 29 Electron-local members (native menus, fs reads, window management, event registrars, and the three settings proxies with main-side broadcasts) are hand-written and typed by `ElectronBondSurface`, which also forces the web shim to acknowledge every one. Protocol skew between app and daemon hard-fails with a "daemon out of date" dialog (desktop) or a `mismatch` banner (web) — the version rides `/health`, `bond.auth`, and `bond.ping`.

### Shared (`src/shared/`)

| File | Purpose |
|------|---------|
| `protocol.ts` | JSON-RPC 2.0 types and helpers + `PROTOCOL_VERSION` (bump on any breaking rpc-schema change; equality = compatibility) |
| `rpc-schema.ts` | **Single source of truth for the RPC contract** — `RpcMethods` (per-method params/result), `RpcNotifications`, `RPC_METHOD_NAMES`; server handlers, both clients, preload, and the shim all derive from it, so contract drift is a compile error |
| `bond-surface.ts` | The `window.bond` surface builder — `buildDaemonSurface(invoke)` generates the 130 daemon proxies from the registry; `ElectronBondSurface` declares the 29 main-process-local members the shim must explicitly stub |
| `stream.ts` | `BondStreamChunk` union type (text, thinking, tool, approval, error, system) |
| `client.ts` | `BondClient` WebSocket client class — registry-typed `call`, token provider, reconnect-in-place, `daemonProtocolVersion` |
| `session.ts` | Session, SessionMessage, EditMode, AttachedImage, Collection, FieldDef/FieldOption/FieldDefInput, and media/collection types |
| `fields.ts` | **Field-type registry** — per-type `coerce`/`validate`/`format`/`compare`/`defaultValue` for every `FieldType`, plus `normalizeSchema` (legacy `string[]` options → canonical `FieldOption[]`), `validateSchema`, `coerceItemData` (the single item write gate), `isDoneValue`, and the issue-key regexes (`ISSUE_PREFIX_RE`, `ISSUE_KEY_RE`). Shared by daemon (enforcement), renderer (render/edit/sort), and CLI (parse/format) — add a `FieldType` without a registry entry and the compiler objects |
| `agents.ts` | Agent roster types — `AgentSettings` (model/thinking/report/policy/leash/instructions/tools), `AgentSummary`, `GRANTABLE_AGENT_TOOLS` (read-only tools only), `normalizeAgentSettings`. Every agent is read-only and artifact-producing; Bond applies changes through its own approvals |
| `memory.ts` | Memory wire types — CoreMemory, `WorkingState` (incl. `artifacts`/`activeSkill`/`checkpoint`), MemoryItem, RetrievedMemory, and `MemoryHealth`/`MemoryRunSummary` (the health report behind `memory.health`, `bond memory status`, and the MemoryView badge). Mirrors `daemon/memory/types.ts` — extend both together |
| `sense.ts` | SenseSession, SenseCapture, SenseSettings, SenseState, DetectedWindow, OcrResult, AccessibilityResult types |
| `library.ts` | `AssetKind`, `AssetFormat`, `LibraryAsset`, `AssetReference`, `AssetBacklink` — the Library asset model shared by daemon, renderer, and CLI |
| `models.ts` | `ModelId` — provider-neutral capability tiers (`'high' | 'balanced' | 'fast'`); Pi maps them to concrete models |
| `web.ts` | `WebRenderRequest`/`WebRenderResult` — the daemon ↔ app hidden-browser render round-trip |
| `desk.ts` | Desk's wire types (threads, blocks, segments, matchers, questions, status, stats), `DESK_TIMING` (the ~3 min noise floor, ~11 min working sphere, 60 min session gap, 10 min assertion budget), and `formatApproxDuration` — `~1h 20m`, never `1h 23m` |

### CLI (`bin/bond`)

`bin/bond` is a bash wrapper for daemon lifecycle (`status`/`start`/`stop`/`restart`/`dev`/`rebuild`/`log`/`build`) plus thin Node entrypoints that connect to the daemon over the socket. The Node subcommands are bundled by `npm run build:cli` into `out/cli/` and rebuilt on demand: `media`, `sense`, `soul`, `collection`, `screenshot`, `mcp`, `library`, `ask`, `desk`, `memory`. Their sources live in `src/cli/` (`connect.ts` handles the Pi auth connect flow; `library-helpers.ts` holds `library.ts`'s pure logic — id/number resolution, format detection — split out so it's unit-testable without triggering the CLI's `main()` on import; `ask-helpers.ts` is the same split for `ask.ts`). `bond desk` is Desk's only surface until the notch panel lands — `status`, `on`/`off`, `blocks`, `threads`, `matchers`, `answer`, and above all `stats`, which is where a day of dogfooding becomes a go/no-go decision instead of an impression. `bond memory` (`status`, `--json`) answers the one question the 2026-07-21 memory incident could not: is memory actually writing — last-written times, observer lag, consecutive failures, last error, recent runs; it exits non-zero when degraded. `bond ask` shows and answers Bond's pending `ask_user_question` — a bare number picks an option, `--text`/`--cancel` answer directly, `--json` (or a non-TTY caller with no explicit answer) prints the pending question as JSON and never blocks. See the "Commands" section above for the common daemon workflows.

## Project Structure

```
bin/bond                             # CLI for daemon management
scripts/
  build-native-helpers.sh            # Compiles Obj-C native helpers → out/daemon/bin/sense/
src/
  cli/
    media.ts                         # bond media — CLI for media management
    library.ts                       # bond library — CLI for Library assets + collection references
    library-helpers.ts               # Pure library.ts logic (id/number resolution, format detection)
    screenshot.ts                    # bond screenshot — capture Bond window
    mcp.ts                           # bond mcp — servers, trust policy, tool classification, Keychain secrets
    sense.ts                         # bond sense — CLI for Sense ambient awareness
    ask.ts                           # bond ask — show/answer Bond's pending ask_user_question
    memory.ts                        # bond memory — memory write health
    memory-helpers.ts                # Pure memory.ts formatting (age, status report, degraded check)
    desk.ts                          # bond desk — status, on/off, blocks, threads, matchers, answer, stats
    desk-helpers.ts                  # Pure desk.ts logic (arg parsing, formatting)
    ask-helpers.ts                   # Pure ask.ts logic (arg parsing, answer-line parsing, formatting)
  native/
    window-helper.m                  # CGWindowList native helper (Obj-C) — emits layer + frame
    notch-helper.m                   # Per-display notch/menu-bar geometry via NSScreen (Obj-C)
    ocr-helper.m                     # Apple Vision OCR native helper (Obj-C)
    accessibility-helper.m           # AXUIElement tree walker native helper (Obj-C)
  daemon/
    main.ts                          # Daemon entry point
    server.ts                        # WebSocket JSON-RPC server (thin dispatch)
    turns.ts                         # Turn runner — serialized send lifecycle
    approvals.ts                     # Single pending-approval registry
    questions.ts                     # Single pending-question registry (ask_user_question)
    agent.ts                         # Bond prompt and Pi runtime entrypoint
     pi/runtime.ts                    # Pi session, event, and permission bridge
    sessions.ts                      # Session CRUD (SQLite)
    images.ts                        # Image file storage + images table (mirrors into assets)
    library.ts                       # Library data layer — assets table + asset_references join table
    imagegen.ts                      # Glue for the bundled codex_generate_image Pi tool
    db.ts                            # Database management + migrations
    settings.ts                      # Settings storage
    paths.ts                         # Data directory paths
    skills.ts                        # Skill scanning from ~/.bond/skills/
    fts.ts                           # Safe FTS5 MATCH query construction
    remote.ts                        # Remote (LAN) access — static bundle + WebSocket RPC on TCP 3113
    mcp/
      manager.ts                     # Daemon-lifetime MCP connection registry (lazy, warm, contained)
      client.ts                      # One server connection over the MCP SDK (stdio + streamable http)
      config.ts                      # McpServerConfig + policy CRUD over the mcp.servers setting
      policy.ts                      # Trust policy + decideMcpCall — the single approval gate
      keychain.ts                    # macOS Keychain secrets behind keychain:<ref> config references
      tools.ts                       # The `mcp` proxy tool + promoted mcp__server__tool Pi tools
      content.ts                     # MCP result → text (flatten, truncate, placeholders)
    web/
      tools.ts                       # web_search + fetch_content Pi tools (keyless, cached)
      broker.ts                      # Render broker for the app's hidden browser window
      extract.ts                     # DDG SERP parsing + Readability/Turndown markdown
    memory/
      ledger.ts                      # memory_runs table + getMemoryHealth()
      artifacts.ts                   # Deterministic tool-event → working-memory patch rules
    questions/
      tools.ts                       # ask_user_question Pi tool — parks the turn on questions.ts until answered
    desk/
      signature.ts                   # Resource signatures + the redaction boundary for titles/paths
      store.ts                       # Threads, blocks, segments, desk_runtime singleton
      matchers.ts                    # Deterministic matching, the authority matrix, suppressions
      merge.ts                       # Transactional thread merge + suppression collision folding
      segmenter.ts                   # Captures → segments → blocks; eligibility gate, presence, smoothing
      inference.ts                   # Batched unknown-resource classification (runPiTextPrompt, 'fast')
      questions.ts                   # Ask lifecycle under the persisted ten-minute budget
      notes.ts                       # Re-entry note generation at departure
      retention.ts                   # The Desk sweep, riding Sense's textRetentionDays cutoff
      today.ts                       # Idempotent Today collection + todo ↔ thread links
      service.ts                     # RPC facade + desk.changed broadcast
      worker.ts                      # 2s segmentation + 15-min sweep on one serialized queue
      stats.ts                       # Instrumentation for the Phase 2 go/no-go
      tools.ts                       # open_desk Pi tool
    agents/
      tools.ts                       # consult_agent Pi tool + roster prompt section
      definition.ts                  # AGENT.md parsing + validation
      registry.ts                    # Bundled + ~/.bond/agents roster (user overrides builtin)
      run-agent.ts                   # Isolated read-only agent session runner
      prompt.ts                      # Agent spine + doctrine + verb workflow assembly
      evidence.ts                    # Native + approved-shell evidence runners
      context-docs.ts                # Declared context-doc resolution
      service.ts                     # agents.* RPC service
      builtin/felix.ts               # Felix — design consultant (bundled AGENT.md)
      builtin/q.ts                   # Q — coding consultant (bundled AGENT.md)
    design/
      detector.ts                    # Pinned impeccable detect --json wrapper (Felix native runner)
      migrate.ts                     # Literal inventory → cluster → token mapping (Felix native runner)
    sense/
      controller.ts                  # State machine (disabled/armed/recording/idle/paused/suspended)
      presence.ts                    # Idle detection via ioreg
      window-detector.ts             # App/window polling via bond-window-helper
      clipboard.ts                   # Clipboard mirroring via pbpaste
      privacy.ts                     # Blacklist checking + ambiguity detection
      accessibility.ts               # Accessibility tree extraction wrapper
      ocr.ts                         # OCR extraction wrapper
      text-router.ts                 # Accessibility vs. OCR routing
      redaction.ts                   # Security redaction engine
      worker.ts                      # Queue-based text extraction worker
      storage.ts                     # Retention enforcement + auto-cleanup
      helpers.ts                     # Native binary path resolution
  main/
    index.ts                         # Electron main process
    sense.ts                         # Sense capture coordinator (desktopCapturer)
    tray.ts                          # Menu bar tray icon for Sense state
    web.ts                           # Hidden-browser render host for daemon web tools
    desk.ts                          # Desk window host registry
    desk-window.ts                   # The level-27 NSPanel, cursor poll, display following
    desk-fullscreen.ts               # Desk's own window-helper poll for fullscreen suppression
    notch-geometry.ts                # Per-display notch + menu-bar geometry (helper + fallback)
  preload/index.ts                   # contextBridge API
  shared/
    protocol.ts                      # JSON-RPC 2.0 types + PROTOCOL_VERSION
    rpc-schema.ts                    # Typed RPC method/notification registry (the wire contract)
    bond-surface.ts                  # window.bond surface builder (preload + shim derive from it)
    stream.ts                        # BondStreamChunk types (incl. thinking_text)
    client.ts                        # BondClient WebSocket client
    session.ts                       # Session, SessionMessage, Collection, CollectionItem, EditMode, AttachedImage types
    fields.ts                        # Field-type registry (coerce/validate/format/compare), schema normalization/validation, issue-key regexes
    sense.ts                         # SenseSession, SenseCapture, SenseSettings, DetectedWindow, OcrResult types
    library.ts                       # AssetKind, AssetFormat, LibraryAsset, AssetReference, AssetBacklink types
    models.ts                        # ModelId type
    web.ts                           # WebRenderRequest/WebRenderResult render round-trip types
    desk.ts                          # Desk thread/block/segment/matcher/question types, DESK_TIMING, formatApproxDuration
    desk-window.ts                   # main <-> Desk-renderer contract (geometry, hit rects)
  renderer/
    App.vue                          # Root shell — panel layout + view routing
    web/
      index.html                     # Browser entry served by the daemon's remote server
      main.ts                        # Installs the window.bond shim, mounts WebApp
      WebApp.vue                     # Single-column phone-friendly chat (reuses MessageBubble/ChatInput/ApprovalPrompt)
      client.ts                      # WebBondClient — JSON-RPC over native WebSocket, pairing token, reconnect
      shim.ts                        # window.bond built on WebBondClient; Electron-only methods become no-ops
    ViewerWindow.vue                 # Markdown/plaintext file viewer window (Library documents)
    DeskWindow.vue                   # The notch panel — Rest / Glance / Ask / Open
    desk.html / desk-main.ts         # Desk window entry
    desk.css                         # Strips app.css window chrome from the transparent panel
    app.css                          # Tailwind v4 theme tokens
    types/message.ts                 # Message union type
    types/webview.d.ts               # Electron webview element types
    composables/
      useChat.ts                     # Continuous transcript state, streaming, message persistence
      useAutoScroll.ts               # Smart scroll-to-bottom
      useAccentColor.ts              # Dynamic accent color theming
      useSense.ts                    # Sense timeline state, day loading, capture selection, search
      useIssueReferences.ts          # Singleton PREFIX-n reference index (one collection.listReferences RPC)
      useLibrary.ts                  # Library asset list state — filter/search/load/delete
    directives/
      tooltip.ts                     # v-tooltip directive (singleton, positioned tooltips)
    components/
      BondText.vue                   # Polymorphic text primitive
      BondButton.vue                 # Button primitive (primary/secondary/ghost/danger)
      BondInput.vue                  # Text input with v-model
      BondTextarea.vue               # Multi-line textarea with v-model
      BondSelect.vue                 # Dropdown select
      BondFlyoutMenu.vue             # Teleported flyout menu primitive
      BondTab.vue                    # Segmented tab bar
      BondPanelGroup.vue             # Resizable panel container
      BondPanel.vue                  # Individual resizable panel
      BondToolbar.vue                # Standardized toolbar (grid layout, start/middle/end slots)
      BondPanelHandle.vue            # Drag handle between panels
      panelTypes.ts                  # Panel system types + injection key
      ViewShell.vue                  # View wrapper (sticky header/footer, scroll area)
      ChatInput.vue                  # Textarea + model/edit-mode selectors + attach + send/stop
      ApprovalPrompt.vue             # Tool approval prompt stacked above the composer
      QuestionPrompt.vue             # ask_user_question prompt stacked above the composer, numbered + keyboard-answerable
      MessageBubble.vue              # Renders message variants incl. turn activity
      TurnActivity.vue               # Unified in-chat turn activity timeline
      MarkdownMessage.vue            # Markdown with syntax highlighting + copy
      ThinkingIndicator.vue          # Standalone "Bond is working..." dots (unused, kept for reference)
      LibraryView.vue                # Library grid — documents + media, filter/search, two-click delete
      CopyButton.vue                 # Inline copy-to-clipboard button
      MissionBriefing.vue            # Empty transcript welcome screen
      SettingsView.vue               # Accent color, model, personality settings
      AgentsView.vue                 # Settings-window Agents tab (roster + per-agent settings)
      AboutView.vue                  # Architecture, tools, data paths, CLI reference
      DesignSystemView.vue           # Live design token browser
      SenseView.vue                  # Sense timeline main view (day nav + detail + timeline dock)
      SenseDayNav.vue                # Date navigation (prev/next/picker)
      SenseTimeline.vue              # Density bar scrubber with playhead and hover preview
      SenseDetail.vue                # Screenshot viewer with metadata and extracted text
      SenseAppLegend.vue             # App color legend with filter chips
      SenseSearch.vue                # Inline search with results flyout
      MemoryView.vue                 # Core/working/search/source memory panel
      DevComponents.vue              # Dev-only component catalog
      fields/FieldValue.vue          # Per-type display for collection field values (single display dispatch)
      fields/FieldEditor.vue         # Per-type input with canonical-value v-model
    lib/highlight.ts                 # highlight.js language registration
    lib/toolCatalog.ts               # Parses proxy-tool descriptions (a bulleted provider catalog) into structure
    lib/clipboard.ts                 # copyToClipboard with insecure-context fallback
    lib/format.ts                    # Shared formatters (tool labels, durations, approval previews)
    lib/fieldColors.ts               # FieldColor palette key → CSS custom property (--field-*)
electron.vite.config.ts                  # Build config (main, preload, renderer)
vite.web.config.ts                       # Browser bundle build for remote access → out/web
electron-builder.yml                     # Packaging config (macOS DMG, extraResources for daemon)
build/icon.icns                          # macOS app icon
```

## Components

**Always use existing components** before creating new ones. When you add a new component or change props/events on an existing one, update this section AND the `DevComponents.vue` catalog.

### v-tooltip (directive)
Global directive for tooltips. Replaces native `title` attributes with styled, animated, positioned tooltips. Singleton DOM element — only one tooltip visible at a time.
- **Usage:** `v-tooltip="'text'"` (string), `v-tooltip="{ content: 'text', placement: 'right' }"` (object), `v-tooltip.bottom="'text'"` (modifier)
- **Placements:** `top` (default), `bottom`, `left`, `right` — auto-flips at viewport edges
- **Timing:** 400ms show delay, 80ms skip delay (when hovering between adjacent triggers quickly), 100ms hide delay
- **Accessibility:** `role="tooltip"`, `aria-describedby`, Escape to dismiss, keyboard focus support
- **Styling:** Inverted colors (dark bg on light mode, light bg on dark mode), arrow pointer, fade+scale animation

### BondText
Polymorphic text component for all UI text. Renders any HTML element via `as` prop. `truncate` also applies `block` and suppresses the default inline `text-wrap: pretty` — as an inline style that property outranked the `.truncate` class and shared the `text-wrap-mode` longhand with `white-space: nowrap`, which silently made the prop a no-op everywhere.
- **Props:** `as?: string` (default: `'span'`), `size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl'`, `weight?: 'normal' | 'medium' | 'semibold' | 'bold'`, `color?: 'primary' | 'muted' | 'accent' | 'err' | 'ok' | 'inherit'`, `align?: 'left' | 'center' | 'right'`, `truncate?: boolean`, `mono?: boolean`
- **Slot:** default — text content

### BondButton
Button with variant and size options. Supports icon-only mode for toolbar buttons.
- **Props:** `variant?: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size?: 'sm' | 'md'`, `icon?: boolean` (square with equal padding), `disabled?: boolean`
- **Slot:** default — button label (or icon when `icon` is true)

### BondInput
Text input with v-model support.
- **Props:** `modelValue?: string`, `placeholder?: string`, `type?: string`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondTextarea
Multi-line textarea with v-model support.
- **Props:** `modelValue?: string`, `placeholder?: string`, `rows?: number`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondSelect
Dropdown select with custom chevron.
- **Props:** `modelValue?: string`, `options: { value, label, color? }[]` (`color` is any CSS color rendered as a dot before the label), `disabled?: boolean`, `placement?: 'top' | 'bottom'`, `variant?: 'default' | 'minimal'` (minimal removes background and border), `size?: 'sm' | 'md'` (default: `'md'`)
- **Events:** `update:modelValue(value: string)`

### FieldValue
Per-type display for collection field values — the single display dispatch shared by CollectionDetail (table/list/cards), CollectionItemDetail, and CollectionEmbed. Rating stars, colored status/priority chips (palette via `lib/fieldColors.ts` → `--field-*` tokens), select badges, tag chips, url links (opens via `window.bond.openExternal`, stops row-click propagation), boolean check, registry `format` text otherwise. Total over garbage values — never throws.
- **Props:** `value: unknown`, `def: FieldDef`

### FieldEditor
Per-type input for collection fields with a **canonical-value** v-model — numbers for number/rating, booleans, `string[]` for tags/multiselect, `undefined` for "not set"; callers pass the model straight to `collection.addItem`/`updateItem` with no string re-parsing. Clickable star rating with arrow-key support, switch toggle for booleans, BondSelect with color dots for select/status/priority (empty option ↔ `undefined`), toggle chips for multiselect options, free chip input for tags, BondInput/BondTextarea/native date otherwise.
- **Props:** `def: FieldDef`, `modelValue: unknown`
- **Events:** `update:modelValue(value: unknown)`

### BondFlyoutMenu
Teleported flyout menu primitive. Renders via `<Teleport to="body">` with fixed positioning relative to an anchor element. Auto-flips when the menu would overflow the viewport, clamps horizontally, and repositions on scroll/resize. Used by BondSelect and similar anchored menus.
- **Props:** `open: boolean`, `anchor: HTMLElement | null`, `placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'`, `width?: number`, `padding?: boolean`
- **Events:** `close()`
- **Slot:** default — menu content

### BondTab
Segmented tab bar.
- **Props:** `tabs: { id, label }[]`, `modelValue?: string`
- **Events:** `update:modelValue(value: string)`

### BondPanelGroup
Flex container that manages resizable panel layout. Nest `BondPanel` and `BondPanelHandle` as direct children. Pixel-unit panels use `flex-shrink: 1` so they participate in CSS flexbox shrinking when the container is too small, with CSS `min-width`/`min-height` enforcing minimums natively. JS state is synced to DOM at drag/animation start via `syncPxStateToDom()`.
- **Props:** `direction?: 'horizontal' | 'vertical'`, `autoSaveId?: string` (localStorage key), `keyboardStep?: number` (default: 5)
- **Events:** `layoutChange(layout)` (during drag), `layoutChanged(layout)` (after drag ends)
- **Expose:** `getLayout()`, `setLayout(layout)`

### BondPanel
Individual resizable panel. Must be a direct child of `BondPanelGroup`. Slot props: `{ size, collapsed }`. Applies CSS `min-width` (horizontal) or `min-height` (vertical) from the group's `getMinDimStyle()` — suppressed during collapse/expand animation.
- **Props:** `id: string`, `defaultSize?: number` (%), `minSize?: number` (% default: 10), `maxSize?: number` (% default: 100), `minSizePx?: number` (optional, pixel-based minimum — enforced via CSS min-width), `unit?: 'px' | '%'` (default: `'%'`), `collapsible?: boolean`, `collapsedSize?: number` (% default: 0), `header?: string` (renders a section header with collapse/expand chevron when collapsible)
- **Slots:** `default` (panel content), `header-extra` (extra controls in the header row, e.g. a + button)
- **Expose:** `collapse()`, `expand()`, `getSize()`, `isCollapsed()`, `resize(size)`

### BondToolbar
Standardized toolbar with true-center middle slot. Uses CSS Grid (`1fr auto 1fr`) so the middle content is always visually centered regardless of start/end width. Fixed height via `--toolbar-height` token. Used by ViewShell (header) and SitePreview (browser toolbar).
- **Props:** `label: string` (required, `aria-label`), `border?: 'none' | 'bottom'`, `drag?: boolean` (Electron drag region), `blur?: boolean` (backdrop blur for sticky headers)
- **Slots:** `start` (left-aligned), `middle` (true-centered), `end` (right-aligned)
- **Accessibility:** `role="toolbar"`, `aria-label`

### BondPanelHandle
Drag handle placed between panels. Supports pointer drag, keyboard arrows, Home/End. Styled via `data-state` attribute (`inactive` | `hover` | `drag`).
- **Props:** `id: string` (format: `handle-N`), `disabled?: boolean`, `hitArea?: number` (px, default: 8)
- **Accessibility:** `role="separator"`, arrow keys, `aria-orientation`

### ViewShell
View wrapper with sticky header (using BondToolbar), scrollable content area, and optional sticky footer. Backdrop blur on both header and footer edges.
- **Props:** `title: string`, `subtitle?: string`
- **Slots:** `header-start` (optional start content in toolbar), `header-end` (optional end content in toolbar), `default` (main content), `footer` (optional sticky footer)
- **Expose:** `scrollAreaEl` (the scrollable container element)

### ChatInput
Unified composer combining textarea, attachments, context usage, reasoning and permissions settings, and send/stop actions. Auto-focuses after response completes.
- **Props:** `busy: boolean`, `model: ModelId`, `editMode: EditMode`, `contextUsage?: { inputTokens, contextWindow, costUsd }`
- **Events:** `submit(text: string, images: AttachedImage[])`, `cancel()`, `update:model(value: ModelId)`, `update:editMode(value: EditMode)`
- Single bordered container with textarea on top and a toolbar row below. A sliders icon immediately left of the send/stop actions opens one top-aligned menu with Reasoning (high/balanced/fast) and Permissions (readonly/scoped/full) sections. Attach opens the native jpeg/png/gif/webp picker. Image thumbnails appear above the textarea. Scoped permission mode shows a paths input.

### ApprovalPrompt
Focused tool approval request stacked above ChatInput while leaving the normal composer usable. Shows the tool, description, and a formatted command/path/input preview.
- **Props:** `requestId: string`, `toolName: string`, `input: Record<string, unknown>`, `description?: string`, `context?: string` (background context)
- **Events:** `respond(requestId: string, approved: boolean)`

### QuestionPrompt
Focused `ask_user_question` prompt stacked above ChatInput, same slot as ApprovalPrompt. Numbered options (daemon-minted ids); auto-focuses on mount so `1`–`9` answer immediately without stealing text input — the keydown handler ignores events from an `INPUT`/`TEXTAREA`/`contentEditable` target. `Escape` or the dismiss button cancels. Typing a custom answer into the composer while a question is pending resolves it directly (`useChat.ts`'s `submit()` intercept) rather than starting a new turn.
- **Props:** `questionId: string`, `question: string`, `header?: string`, `options: QuestionOption[]`
- **Events:** `answer(questionId: string, answer: QuestionAnswer)`

### MessageBubble
Renders all message variants based on the `Message` union type. Delegates markdown to MarkdownMessage and turn activity rows to TurnActivity. User messages render attached images above text. Generated images (`meta`/`image`) render start-aligned with a loading placeholder until their base64 resolves.
- **Props:** `msg: Message` — role/kind determines which variant renders
- **Events:** `approve(requestId: string, approved: boolean)` — emitted from approval controls inside turn activity

### TurnActivity
Unified turn activity row persisted as one `meta/activity` message per user turn. Compact row streams current status; expansion shows chronological thinking text, tool input/output previews, timings, approvals, and errors. Completed rows collapse to a small summary. Failures and approval requests set `expanded: true` automatically. Full details live in `SessionMessage.data` and the `messages.data` JSON column.
- **Props:** `data: TurnActivityData`
- **Events:** `approve(requestId: string, approved: boolean)`

### MarkdownMessage
Renders markdown with syntax highlighting and copy-to-clipboard code blocks. Uses marked.js, DOMPurify, and highlight.js.
- **Props:** `text: string`, `streaming: boolean`
- Throttled rendering during streaming. External links open via `window.bond.openExternal()`.

### ThinkingIndicator
Standalone animated "Bond is working..." with blinking dots. No longer used in the main app — live turn status is handled by TurnActivity. Kept as a standalone component file.


### CopyButton
Inline copy-to-clipboard button with checkmark confirmation feedback.
- **Props:** `value: string`

### SettingsView
Settings panel with accent color picker (8 presets + custom), default model selector, and personality/soul text editor. No props — reads/writes via `window.bond` directly.

### AgentsView
Settings-window Agents tab — the specialist roster, driven by `agents.list`. Each agent card shows identity, verbs, and its evidence runners (with approve/revoke state), plus editable settings: model tier, thinking level, report depth, consult policy, time limit (leash), extra tool grants, and per-agent instructions. Invalid definitions surface in a problems banner. No props — reads/writes via `window.bond` directly.

### McpSettings
Settings section for MCP (Model Context Protocol) connections. Joins saved config (`mcp.list`) with live connection state (`mcp.status`) per row: status dot, tool count, endpoint (command line or url), Keychain badge, last error. Enable/disable toggle, reconnect, two-click remove, one-click preset connect, and an "Add from JSON" paste form. Expanding a row connects the server on demand and shows its trust selector plus, per tool, one three-state permission control (Ask / Read / Write) and a pin toggle. A proxy tool's **reach** — the providers hidden inside its description — renders as chips, one click each for the full text (see `lib/toolCatalog.ts`); an always-ask flag set from the CLI shows as a chip that clears in one click. For http servers there's a token field that writes straight to the Keychain and stores only a `keychain:<ref>` in the config. Reloads on the `mcp.changed` push so a second window stays in sync. No props or events — talks to `window.bond` directly.

### DesignSystemView
Interactive design token showcase. Displays color swatches, typography, radius, shadows, transitions, and spacing values. Reads computed styles from `:root`. No props.

### AboutView
In-app reference screen showing Bond's architecture (layered stack diagram), agent tools, edit modes, data paths, and CLI commands. Accessible from the sidebar gear menu.

### SenseView
Main Sense timeline view. Two-zone vertical layout: header with day nav + search, detail viewer in the body, and a bottom dock with app legend + density bar timeline. Loads the current day's captures on mount.
- **Props:** `insetStart?: boolean`
- **Slots:** `header-start`

### SenseDayNav
Date navigation in the SenseView header. Shows formatted date with prev/next arrows and a hidden native date picker.
- **Props:** `date: string`, `isToday: boolean`, `captureCount: number`, `sessionCount: number`
- **Events:** `prev()`, `next()`, `pick(date: string)`

### SenseTimeline
Core density bar scrubber. Divides the day into 1440 minute-buckets, renders visible range as vertical bars (height = capture density, color = dominant app). Supports scroll-to-scrub (mouse wheel), keyboard nav (Left/Right, Shift+arrows for session boundaries), click-to-select, and hover preview tooltip.
- **Props:** `captures: SenseCapture[]`, `sessions: SenseSession[]`, `activeCaptureId: string | null`, `appFilter: string | null`
- **Events:** `select(id: string)`

### SenseDetail
Screenshot viewer above the timeline. Shows the selected capture's image (object-fit contain), metadata bar (app name, window title, time, trigger badge, ambiguity warning), and collapsible extracted text panel. Has states for loading, purged, and empty.
- **Props:** `capture: SenseCapture | null`, `image: string | null`, `loadingImage: boolean`

### SenseAppLegend
Horizontal strip of colored chips for the top 8 apps active that day. Click a chip to filter the timeline to that app; click again to clear.
- **Props:** `apps: AppSummary[]`, `activeFilter: string | null`
- **Events:** `filter(bundleId: string)`

### SenseSearch
Inline search input in the header bar. Debounced 300ms text search with results in a BondFlyoutMenu dropdown. Each result shows app name, time, and highlighted text excerpt.
- **Props:** `results: SenseCapture[]`, `query: string`
- **Events:** `search(query: string)`, `select(capture: SenseCapture)`, `clear()`
- **Expose:** `focus()`

### MemoryView
Right-panel memory view for inspecting and editing Bond memory. A health line sits above the tabs (`memory.health`): last-written time plus observer lag, muted normally and `color="err"` with the last error when the observer has ≥2 consecutive failures or is >48 seqs behind — stale memory used to look exactly like fresh memory here.
- **Tabs:** Core, Working, Search, Source
- **Core:** stable facts, preferences, and decisions persisted to `memory/core.json`
- **Working:** current scratchpad goal, facts, preferences, decisions, and open threads, plus a read-only **Working on** block listing the deterministically captured artifacts, active skill, and checkpoint (the model cannot write those, so neither can this editor)
- **Search:** memory item search with inline edit/delete controls
- **Source:** source messages attached to a selected memory item

### DevComponents
Dev-only component catalog with live previews and prop/event documentation. Accessible from the Settings window Components tab. Not rendered in production flows.

## Composables

### useChat(deps)
All continuous transcript state and logic. Handles message streaming, persistence, tool approvals, ask_user_question, turn activity, and HMR-safe state preservation. On submit, creates one `meta/activity` message for the turn. Thinking/tool/result/approval/question chunks update that activity message's `data.events`; assistant text still streams into normal Bond messages. Pending approvals and the pending question are exposed separately so App can stack their prompts above the composer while normal input remains usable. Composer text typed while a question is pending is intercepted in `submit()` as that question's custom answer (no new turn, no queue). Answering a question — by option, keyboard number, or typed text, on this device or another — also appends a normal `role: 'user'` bubble with the chosen text, so the exchange reads like an ordinary message in the transcript flow rather than staying buried in the (often-collapsed) activity row. That bubble's id is **derived** (`answer-<questionId>`), never minted: the daemon echoes `question_resolved` to every subscriber including the answerer (and the notification beats the RPC ack down the same socket), so all three append paths must write the same row or one answer becomes three. Answering mid-turn also **closes the current activity row and continues the turn in a fresh one** under the same `turnId` — the answer bubble appends at the end of the transcript, so without the split the live row would sit stranded above it and a working turn would read as dead. `completeTurn` finalizes every activity row carrying the turnId (not just the one it inserted), so a continuation row can't be stranded on "Working" by a client that dies mid-turn.
- **State:** `messages`, `busy`, `currentSessionId`, `pendingApprovals`, `pendingQuestion`
- **Methods:** `submit()`, `cancel()`, `respondToApproval()`, `answerQuestion()`, `subscribe()`, `unsubscribe()`, `loadSession()`, `clearMessages()`, `persistMessages()`


### useAutoScroll(containerRef)
Smart scroll-to-bottom for streaming content. Uses MutationObserver and ResizeObserver.
- **State:** `isAtBottom`
- **Methods:** `scrollToBottom()`

### useAccentColor()
Dynamic accent color theming. Derives a full palette from a single hex color (HSL-based tinting for backgrounds, borders, and text).
- **State:** `accent`, `defaultAccent`
- **Methods:** `load()`, `setAccent()`, `reset()`


### useSense()
Singleton Sense timeline state. Loads a day's captures and sessions, selects individual captures with image fetching, text search, and app filtering. Normalizes snake_case DB rows to camelCase.
- **State:** `date`, `captures`, `sessions`, `activeCapture`, `activeCaptureImage`, `searchQuery`, `searchResults`, `appFilter`, `apps`, `loading`, `loadingImage`, `filteredCaptures`, `isToday`
- **Methods:** `loadDay(dateStr)`, `selectCapture(id)`, `search(query)`, `setAppFilter(bundleId?)`, `nextDay()`, `prevDay()`, `jumpToCapture(capture)`
- **Exports:** `appHue(identifier)`, `appColor(identifier, isDark?)` — deterministic HSL color from bundle ID

### useIssueReferences()
Singleton PREFIX-n issue reference index. One `collection.listReferences` RPC feeds composer autocomplete (ChatInput), message chips + hover cards (MessageBubble), reloading on `collections.changed`. Consumers MUST gate key decoration on `knownPrefixes`/`byKey` — the bare `[A-Z]{2,6}-\d+` pattern also matches prose like "UTF-8".
- **State:** `references` (CollectionReference[]), `byKey` (Map by "BOND-12"), `knownPrefixes` (Set)
- **Methods:** `load()` (coalesces concurrent calls)
- **Test helper:** `resetIssueReferencesForTest()`

### useMemory()
Singleton memory panel state backing `MemoryView`. Loads core, working, search results, and source messages via the `memory.*` RPCs.
- **State:** `core`, `working` (incl. `artifacts`/`activeSkill`/`checkpoint`), `results`, `sources`, `loading`, `saving`, `error`, `isEmpty`
- **Methods:** `loadMemory()`, `saveCore()`, `saveWorking()`, `clearWorking()`, `search()`, `upsert()`, `remove()`, `loadSources()`

### useLibrary()
Per-instance Library asset list state backing `LibraryView`. Loads via `library.list` with an optional kind filter (`'document' | 'media' | 'all'`) and search query.
- **State:** `assets` (LibraryAsset[]), `kindFilter`, `query`, `loading`
- **Methods:** `load()`, `deleteAsset(id)`

### Props (all optional)
- **size**: `number | string` — width & height (default: `24`)
- **color**: `string` — stroke/fill color, any CSS value (default: `currentColor`)
- **weight**: `"thin" | "light" | "regular" | "bold" | "fill" | "duotone"` (default: `"regular"`)
- **mirrored**: `boolean` — flip horizontally for RTL

### Rules
- **Always use `currentColor`** (the default) so icons inherit text color from their parent.
- **Import individually** — never register globally, to keep bundles small.
- Browse available icons at [phosphoricons.com](https://phosphoricons.com).

## Design Tokens

Colors are defined in `app.css` via Tailwind v4's `@theme` directive. Dark mode uses `prefers-color-scheme` media query. Use the existing token names (`bg`, `surface`, `border`, `text-primary`, `muted`, `accent`, `err`, `ok`, `tint`) in Tailwind classes.

### Color tokens
| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `bg` | `#f6f5f2` | `#0f1114` | Page background |
| `surface` | `#fff` | `#181b21` | Cards, inputs |
| `border` | `#ddd9d0` | `#343b45` | Borders, dividers |
| `text-primary` | `#1a1c1f` | `#e8eaed` | Main text |
| `muted` | `#5c6570` | `#8b939e` | Secondary text |
| `accent` | `#7a5c3b` | `#c4a07c` | Interactive elements (customizable) |
| `err` | `#e57373` | `#ef9a9a` | Error states |
| `ok` | `#81c784` | `#a5d6a7` | Success states |
| `tint` | `rgba(255,255,255,0.65)` | `rgba(255,255,255,0.08)` | Overlay tints |

### Other tokens
- **Radius:** `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (12px)
- **Shadows:** `--shadow-sm`, `--shadow-md`, `--shadow-lg` (stronger in dark mode)
- **Transitions:** `--transition-fast` (0.12s), `--transition-base` (0.15s)
- **Layout:** `--toolbar-height` (2.25rem / 36px)
- **Fonts:** `--font-sans` (Inter stack), `--font-mono` (SF Mono stack)
- **Sidebar:** Separate token set (`--sidebar-border`, `--sidebar-text`, `--sidebar-hover-bg`, etc.) using rgba for transparency-based theming

## Message Types

```typescript
type Message =
  | { id, role: 'user', text, images?: AttachedImage[], imageIds?: string[] }
  | { id, role: 'bond', text, streaming: boolean }
  | { id, role: 'meta', kind: 'tool', name, summary? }
  | { id, role: 'meta', kind: 'skill', name, args? }
  | { id, role: 'meta', kind: 'thinking', text, durationSec?, streaming: boolean } // legacy persisted rows only
  | { id, role: 'meta', kind: 'activity', data: TurnActivityData } // events include thinking/tool/responding/approval/question/error — question carries the ask_user_question card (options, status, chosen answer)
  | { id, role: 'meta', kind: 'image', imageIds: string[], images?: AttachedImage[], alt? } // generated images (codex_generate_image)
  | { id, role: 'meta', kind: 'error', text }
  | { id, role: 'meta', kind: 'approval', requestId, toolName, input, title?, description?, status: 'pending' | 'approved' | 'denied' }
  | { id, role: 'meta', kind: 'system', text }
```

## Edit Modes

Bond supports three edit modes that control which Pi tools are available for the current turn:

```typescript
type EditMode =
  | { type: 'full' }                              // All tools (Read, Write, Edit, Bash, etc.)
  | { type: 'readonly' }                           // Read, Glob, Grep only
  | { type: 'scoped', allowedPaths: string[] }     // Read/write restricted to specific paths
```

MCP tools are the one exception to per-mode tool lists being about workspace files. Availability and approval are decided by the per-server **trust policy** (`src/daemon/mcp/policy.ts`), not the edit mode alone: a new server defaults to `trust: 'ask'` with nothing classified, which prompts for every call in every mode. Marking a server **trusted** auto-runs only what a human confirmed **read-only** — a confirmed *write* always asks, in every mode including `full`, because full mode's standing approval covers Bond's own workspace (recoverable, on this machine) and not an irreversible write into someone else's system. `readonly` sessions see only confirmed read-only tools, and the proxy disappears entirely until at least one exists. `alwaysAsk` outranks trust; `disabled` blocks the server outright. Promoted tools (`mcp__server__tool`) pass through the same gate.

**Proxy servers get sub-tool rules.** One tool name can front many operations selected by argument (`execute-tool {provider: linear, subtool: create-issue}`), so judging by tool name alone would let one classification govern both reads and writes. `routeSpecFromSchema` derives the routing arguments from the tool's input schema (leading string properties, with `Legacy alias for \`x\`` descriptions bound to the segment they stand in for — missing that is a bypass), `routeKeyFor` builds `linear/create-issue` from a call, and rules are stored scoped as `tool:provider[/subtool]` with the most specific match winning. A call whose route can't be determined never inherits a route-specific allowance.

Edit mode is **one global, daemon-persisted setting** (`edit_mode`, validated through `parseEditMode` in `shared/session.ts`): loaded into the composer at boot on every surface (desktop and web), applied per-turn via `BondSendInput.editMode`, and mirrored live to all clients through the `edit_mode_changed` chunk when any device changes it. `agent.ts` builds Bond's system prompt; `pi/runtime.ts` maps each edit mode to Pi's tool and permission configuration.

## Desk

**Sense is the eye. Desk is what's on your desk** — the work threads currently in flight, the re-entry note for each, and today's todos. It is built entirely on top of the existing Sense capture pipeline: **Desk reads Sense; Sense never knows Desk exists.** The only structural coupling is `desk_capture_links`, which keeps the dependency one-way instead of putting a Desk column on `sense_captures`. Either side can be rewritten independently.

Full design and phasing: `plans/desk.md`. All four phases are implemented.

### The surface

Four states, and **nothing is ever an interrupt** — no modal, no sound, no bounce, no Notification Center entry, no badge. Desk has exactly one channel.

| State | What it is | Trigger |
|---|---|---|
| **Rest** | A hairline below the notch. Colour = thread, dimmed = still deciding. | Always, while running |
| **Glance** | Lozenge — thread + coarse time. | Hover, 400ms delay |
| **Ask** | One line, two answers. Holds ~20s, then retracts. | A stable candidate switch |
| **Open** | In flight + Today, kept structurally separate. | Click |

The heavier work — the day's blocks, thread create/rename/merge/archive, and the buried rules editor — lives in `DeskView.vue`, the fifth right panel. HUDs stay small.

**Anything drawn inside the notch's own footprint is physically invisible.** The framebuffer keeps those pixels and a screenshot shows them perfectly, but the display cannot emit light through the camera housing. Everything that paints starts below the menu bar; the only interactive rectangle above it is the notch's own x-range, which owns no menu bar content. `clampHotRects` enforces that and is the one function that can break the menu bar for the whole machine.

### Product rules — hard lines, not v1 scope cuts

1. **Desk describes. It never grades.** No productivity score, streak, daily target, app-usage bar chart, or comparison to yesterday. Every feature that would rank the day is permanently out of scope.
2. **Time is always approximate.** `~1h 20m`, never `1h 23m` (`formatApproxDuration` in `shared/desk.ts`). Sense samples on an interval and sees nothing during a call or time away from the desk. The tilde is the panel telling you not to audit it.
3. **Correction teaches at the narrowest safe scope.** A reassignment always fixes the block. It creates a durable rule only when a concrete resource pattern is named; otherwise it stores a one-resource attribution and asks nothing further.
4. **Silence is local consent.** An ignored Ask commits the current block and never creates a reusable rule. The user is never blocked and never has to dismiss anything.

### The two paths

**Fast (`segmenter.ts`) — no model call, ever.** Poll capture metadata every 2s, checkpointed by `(captured_at, id)` in `desk_runtime`. App or title changes close one segment and open another. Known resources resolve against `desk_matchers` in one ordered lookup: `confirmed` first, then specificity, then field rank (`path > title > bundle > resource`), then oldest id.

**Slow (`inference.ts`) — batched.** Every pending unknown collapses into ONE 200–500-token `runPiTextPrompt(prompt, 'fast')` request. **Never `runAgentConsult`** — a full agent session per batch is far more machinery and cost than a classification needs.

### Three timescales, kept separate

| Constant | Value | Job |
|---|---|---|
| Noise floor | ~3 min | Below this you are looking something up. **Never surface a named block this short.** |
| Working sphere | ~11–12 min | The altitude Desk operates at. |
| Session gap | ~60 min | Ends a thread. A five-minute coffee break pauses `presence_seconds`; it does not end anything. |

Sense's 60-**second** idle threshold is a *presence* signal and a fourth, separate thing — it must never be reused for task boundaries.

### Things that look like details and are not

- **Titles and paths have never been through `redact()`.** Sense redacts only *extracted* text (`text-router.ts`); `window_title` is written raw at trigger time and gets away with it because Sense only ever displays it back to its owner. Desk **transmits** titles to a model and **persists** them in `evidence_json` and `example_json`, so `desk/signature.ts` redacts on the way out AND on the way in — including on back-fill, because the rows Sense already wrote are raw. `redact()` returns `string | null`; for a title, `null` drops the title, not the segment.
- **The eligibility gate is two conditions.** `image_path IS NOT NULL OR image_purged_at IS NOT NULL` (the survived-the-blacklist-recheck predicate — `image_path` alone is wrong because `enforceStorageCap` purges oldest-first with *no age filter*), plus a **10-second age floor** so a capture whose `onCaptureReady` completed out of order is never leapfrogged by the checkpoint.
- **`presence_seconds` is derived, not counted.** `min(gap_since_previous, 2 × captureIntervalSeconds)`, read from **settings** — `captureIntervalSeconds` is user-configurable, and hardcoding the default of 15 would quietly mis-scale every duration for anyone who changed it. A burst of six clipboard captures in ten seconds must not be credited as six intervals.
- **Smoothing is over time, not a count.** Sense's cadence is irregular, so "the last eight captures" can span thirty seconds or several minutes. The rolling window sums *attributed segment presence time* and requires a clear majority — 40/35/25 is not a switch.
- **`desk_matchers` UNIQUE excludes `thread_id`** — one pattern, one owner. That is what lets the authority matrix refuse to let inference steal a pattern, and it is why a thread merge cannot collide on matchers (only `desk_suppressions` can, and folding it must never *weaken* the suppression).

### Retention

Desk-derived screen data expires with Sense's `textRetentionDays`, swept from `runRetentionCleanup` in `sense/storage.ts`. **No raw title, path, example, summary, generated note, inferred attribution, or orphan inferred thread may outlive it.** What survives is what the user authored: named/renamed threads, todos, confirmed patterns, suppressions (an explicit rejection carrying only an opaque hash), and `user_note` values — including notes that **graduate** from an edited block note onto the thread just before the block expires.

## Memory

Four systems, none authoritative, all previously failing open in silence. On 2026-07-21 all four failed at once and Bond could not resolve "Lets move on to 9." — the plan and the full forensics are in `plans/memory-reliability.md`.

| Layer | Where | Holds |
|---|---|---|
| Pi session context | `pi/runtime.ts` | The live conversation this epoch |
| Working memory | `memory.working` settings row | Goal, **artifacts**, activeSkill, checkpoint, facts, decisions, open threads |
| Core memory | `memory/core.json` | Stable identity facts and preferences |
| Searchable memory | `memory/store.ts` (SQLite + FTS) | Sourced durable memories |
| Transcript FTS | `transcript.ts`, `fts.ts` | Full history, searchable |

### Invariants — these are load-bearing, not preferences

1. **Provenance never gates the payload.** A memory whose sourceId cannot be resolved is a memory with unknown provenance, not a reason to discard the batch. One bad id drops one record; the working state still writes.
2. **Never emit two identifiers and ask for "the id."** `renderTranscriptForMemory` emits exactly one `id` per message (the `seq`); `buildSourceIdResolver` maps whatever comes back — bare seqs, `#696`, uppercase uuids, JSON numbers — onto the canonical uuid. 93% of the incident's 160 rejected tokens were bare seqs.
3. **A failed range still advances.** Only a `model.generate` throw (transport) leaves a marker unmoved. A validation failure that froze the marker meant every subsequent turn re-sent a larger range and failed harder — a permanent, per-turn-billed loop.
4. **Deterministic capture beats inference.** The observer filters the transcript to user/bond TEXT before it sees anything, so it is structurally blind to tool activity. `memory/artifacts.ts` is therefore the ONLY path by which a written file, a filed issue, or a loaded skill can reach working memory. The model may write `checkpoint`; `artifacts` and `activeSkill` are stripped from its patch.
5. **Core memory is additive.** The reflector may add and rephrase; only the user removes (`memory_manage`, `memory.updateCore`, MemoryView). A `fast`-tier model rewriting the whole file every reflection is how a week of daily use produced nine core items.
6. **Epoch markers are seeded at birth** (`createEpoch`), never left at 0. Everything before an epoch exists is the previous epoch's duty, and its rollover hooks cover exactly that range — no gap, no overlap. Unseeded markers made every new epoch re-observe the entire transcript (measured: 521 messages / ~38k tokens in one run).
7. **Short messages need MORE context, not less.** `shouldRecallMemory` is inverted on its own — 14% of user messages fall below it, including "on to 9". `resolveRecallQuery` sends those to search the working state (goal + checkpoint + artifact labels + previous message) instead of searching nothing.
8. **Internal search is a recall tool, not a precision tool.** AND first, then OR, then give up — an empty result teaches Bond the memory does not exist. Quoted spans survive as FTS phrases (sanitized interiors). Roles filter in **SQL**, before LIMIT: post-LIMIT filtering discarded up to 6 of 8 slots to activity rows and returned empty while matches existed.
9. **Pay for stable state once.** Core + working memory ride `systemPromptOverride` (rebuilt per request, never persisted into Pi session history); only query-specific content enters the accumulating envelope. Measured before the split: ~9,100 chars/turn of ~90%-identical text, ~32k tokens in 14 turns — burning the very budget whose exhaustion triggers rollover.
10. **Anything that can degrade must report it.** Every run writes a `memory_runs` row. `bond memory status`, `memory.health`, the MemoryView badge, and the `memory_status` tool all read it. Silence was the meta-failure: the user noticed before the system did.

### Rollover is a backstop, not a strategy

Pi compacts its own session **in place** and the session survives — observed firing at 75.3% of the window with a better summary than Bond ever wrote. Bond's rollover at 0.8 was pre-empting it to solve the same problem worse (it kills the session). `DEFAULT_SOFT_LIMIT_RATIO` is **0.92**, so rollover fires only if Pi's compaction fails to keep up. Consequences: reflection can no longer ride rollover (`scheduleEpochReflection`, every 200 seqs), and the handoff carries a **state snapshot** — goal, artifacts, skill, checkpoint, open threads, plus the closing session's last `{"type":"compaction"}` summary if one exists (only 3 of 16 sessions had one) — instead of a prose tail that once delivered "ok, on to 7!" without the thing being numbered.

## Image Storage

Attached images are stored as permanent files in `~/Library/Application Support/bond/images/{uuid}.{ext}`. Metadata lives in the `images` SQLite table.

```sql
images (id TEXT PK, session_id TEXT FK, filename TEXT, media_type TEXT, size_bytes INT, created_at TEXT)
```

**Flow**: Renderer sends `AttachedImage[]` (base64) → daemon's `bond.send` handler saves files via `images.ts`, returns `imageIds` → renderer swaps inline images for IDs → `messages.images` column stores `["uuid-1", "uuid-2"]` (ID array, not base64).

**Retrieval**: `image.get` and `image.getMultiple` JSON-RPC methods read files from disk and return base64. The renderer resolves IDs on session load via `window.bond.getImages()`.

**Cleanup**: `deleteSession()` calls `deleteSessionImages()` to remove files before CASCADE deletes DB rows.
