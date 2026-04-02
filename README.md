# Bond

Bond is a macOS desktop assistant powered by the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). It runs a standalone daemon that manages Claude conversations, tool use, and session persistence — with a Vue 3 + Tailwind CSS interface wrapped in Electron.

## Requirements

- **Node.js 18+**
- **Claude Code subscription** — Bond authenticates through your existing Claude Code CLI session. No API key or `.env` file needed.

## Quick start

```bash
npm install
npm run dev
```

This builds the daemon, then launches the Electron app with hot-reload via electron-vite.

## CLI

Bond ships a CLI at `bin/bond` for managing the daemon and dev workflow:

```bash
bond status              # Check if daemon is running
bond start               # Start the daemon
bond stop                # Stop the daemon
bond restart             # Stop + start
bond dev                 # Full dev server (stops daemon, runs electron-vite dev)
bond build [daemon|all]  # Build targets (default: all)
bond rebuild [target]    # Stop, build, start
bond log                 # Tail daemon log
bond todo                # Manage todos (list, add, done, undo, rm)
bond project             # Manage projects (list, add, show, edit, archive, rm, resource)
bond media               # Manage media (list, info, open, rm, purge)
bond screenshot          # Capture Bond window to /tmp/bond-screenshot.png
bond test                # Run tests
bond help                # Show all commands
```

## Scripts

| Script              | Description                                         |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | Build daemon + electron-vite dev server              |
| `npm run build`     | Production build (electron-vite + daemon)            |
| `npm run build:daemon` | Build daemon only (esbuild → `out/daemon/main.mjs`) |
| `npm run preview`   | Run electron-vite preview                            |
| `npm run pack`      | Build + package as unpacked `.app` (`dist/mac-arm64/`) |
| `npm run dist`      | Build + package as `.dmg`                             |
| `npm run test:run`  | Run tests once (Vitest)                              |
| `npm test`          | Run tests in watch mode (Vitest)                     |

## Architecture

Bond separates concerns across four layers. The renderer never touches the Agent SDK directly — all queries flow through the daemon over a Unix socket.

```
┌──────────────────┐
│  Renderer (Vue)  │  Chat UI, sessions, settings
└────────┬─────────┘
         │ Electron IPC
┌────────┴─────────┐
│   Main Process   │  Window, daemon lifecycle, IPC proxy
└────────┬─────────┘
         │ Unix socket (WebSocket + JSON-RPC 2.0)
┌────────┴─────────┐
│     Daemon       │  Agent SDK, SQLite, session state
└────────┬─────────┘
         │ HTTPS
┌────────┴─────────┐
│   Claude API     │
└──────────────────┘
```

### 1. Daemon (`src/daemon/`)

A standalone Node.js process that runs independently of the Electron app. Communicates over a Unix domain socket at `~/.bond/bond.sock` using WebSocket with JSON-RPC 2.0.

**Responsibilities:**
- Run agent queries via `@anthropic-ai/claude-agent-sdk`
- Stream response chunks to subscribed clients
- Manage sessions and messages in SQLite (`~/Library/Application Support/bond/bond.db`)
- Handle tool approvals (allow/deny flow)
- Auto-generate session titles via Haiku
- Persist settings (model, soul/personality, accent color)

**Key RPC methods:**
- `bond.send` / `bond.cancel` — query lifecycle
- `bond.subscribe` / `bond.unsubscribe` — chunk streaming
- `bond.setModel` / `bond.getModel` — model selection
- `bond.approvalResponse` — tool approval flow
- `session.*` — CRUD, messages, title generation
- `project.*` — CRUD, resources
- `todo.*` — CRUD, parsing
- `image.*` — list, get, import, delete
- `settings.*` — soul, accent color, window opacity
- `skills.*` — list, refresh, remove

**Agent tools:** Read, Glob, Grep, WebSearch, WebFetch, Edit, Write, Bash — scoped by edit mode (readonly, scoped, or full).

### 2. Main Process (`src/main/`)

Manages the Electron window and proxies IPC calls to the daemon via `BondClient`.

- Spawns the daemon if not already running (checks PID file)
- Resolves the full user PATH via login shell for packaged mode
- Waits for the socket to appear before connecting
- Creates a BrowserWindow with native macOS vibrancy
- Proxies all `bond:*`, `session:*`, and `settings:*` IPC to the daemon
- Screenshot capture support for dev tooling

### 3. Preload (`src/preload/index.ts`)

Exposes `window.bond` to the renderer via `contextBridge` — a typed API surface covering chat, sessions, settings, model selection, and shell utilities.

### 4. Renderer (`src/renderer/`)

Vue 3 + Tailwind CSS v4 chat interface. Composition API throughout.

- **Chat** — message history, streaming responses, tool approvals

Settings, design system, components, and about views live in a separate settings window.

### 5. Shared (`src/shared/`)

Types and utilities shared across all layers:

- `protocol.ts` — JSON-RPC 2.0 request/response/notification types
- `stream.ts` — `BondStreamChunk` union type (text, tool, approval, error, system)
- `client.ts` — `BondClient` WebSocket client class
- `session.ts` — Session, SessionMessage, EditMode, AttachedImage, Project, ProjectResource, TodoItem types
- `models.ts` — `ModelId` type (`'opus' | 'sonnet' | 'haiku'`)

## Data & Runtime

```
~/.bond/
  bond.sock          # Unix domain socket
  daemon.pid         # Process ID
  daemon.log         # Daemon output
  tmp-images/        # Temporary attached images

~/Library/Application Support/bond/
  bond.db            # SQLite (sessions, messages, settings)
```

## Build tooling

- **electron-vite** builds three targets: `out/main`, `out/preload` (ESM), `out/renderer`
- **esbuild** bundles the daemon separately (`out/daemon/main.mjs`)
- **electron-builder** packages the app as a macOS `.dmg` (arm64). Config in `electron-builder.yml`
- **@vitejs/plugin-vue** for SFC compilation
- **Tailwind CSS v4** via `@import "tailwindcss"` — no PostCSS config needed

### Packaging

The daemon runs as a separate system Node.js process, so it lives outside the ASAR archive in `Contents/Resources/daemon/` alongside its native dependencies (`better-sqlite3`, `@anthropic-ai/claude-agent-sdk`). The ASAR contains only the Electron main/preload/renderer code and the `ws` module.

Recipients need Node.js 20+ and Claude Code installed and authenticated. Unsigned builds require `xattr -cr Bond.app` before first launch.

## Repository layout

```
bin/bond                 # CLI for daemon management
src/
  daemon/                # Standalone daemon (Agent SDK, SQLite, WebSocket server)
  main/                  # Electron main process (window, IPC proxy, daemon lifecycle)
  preload/               # contextBridge → window.bond API
  renderer/              # Vue 3 chat UI + Tailwind
    composables/         # State and logic (useChat, useSessions, useProjects, useAutoScroll, useAccentColor, useAppView)
    components/          # Vue components (primitives, layout, chat, views)
    types/               # Message types
    lib/                 # Utilities (highlight.js setup)
  shared/                # Protocol, stream chunks, client, session types, models
electron.vite.config.ts
electron-builder.yml             # Packaging config (macOS DMG, extraResources)
vitest.config.ts
build/icon.icns                  # macOS app icon
package.json
```
