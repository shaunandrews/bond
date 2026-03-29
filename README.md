# Bond

Bond is a local Electron app that chats with an agent powered by the [**Claude Agent SDK**](https://platform.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`). The MVP focuses on **read-only** access to files on your machine: **Read**, **Glob**, and **Grep**, with the agent session rooted at your **home directory**.

## Requirements

- **Node.js 18+**
- **Claude Code subscription** — Bond authenticates through your existing Claude Code CLI session. No API key or `.env` file needed.

## Quick start

```bash
npm install
npm run dev
```

## Scripts

| Script            | Description                                      |
| ----------------- | ------------------------------------------------ |
| `npm run dev`     | Development: electron-vite dev server + Electron |
| `npm run build`   | Production build into `out/`                     |
| `npm run preview` | Run electron-vite preview                        |
| `npm run test:run`| Run tests once (Vitest)                          |
| `npm test`        | Run tests in watch mode (Vitest)                 |

## Architecture

Bond follows the usual Electron split so the Agent SDK never runs in the renderer:

1. **Main process** (`src/main/`)
   - Creates the window, loads the renderer.
   - Handles IPC: `bond:send` (run a user prompt through the SDK), `bond:cancel` (abort the active run).
   - `agent.ts` calls `query()` from `@anthropic-ai/claude-agent-sdk`, streams `SDKMessage` values, and maps them to chunk objects for the UI.

2. **Preload** (`src/preload/index.ts`)
   - Exposes `window.bond`: `send`, `cancel`, `onChunk`.

3. **Renderer** (`src/renderer/`)
   - Vue 3 + Tailwind CSS v4 chat UI; no Node integration in the page.

4. **Shared types** (`src/shared/stream.ts`)
   - `BondStreamChunk` — serializable stream events shared between main, preload, and renderer.

### Build tooling

- **electron-vite** builds three targets: `out/main`, `out/preload` (ESM as `index.mjs`), `out/renderer`.
- **@vitejs/plugin-vue** for SFC compilation.
- **Tailwind CSS v4** via `@import "tailwindcss"` — no PostCSS config needed.

## Agent behavior (MVP)

- **`cwd`**: `os.homedir()` — agent file tools are scoped relative to that.
- **`allowedTools`**: `Read`, `Glob`, `Grep` only — no writes or shell commands.
- **`permissionMode`**: `acceptEdits` — aligns with the SDK's permission model.
- **`systemPrompt`**: Short identity/instruction string for Bond.
- **`CLAUDE_AGENT_SDK_CLIENT_APP`**: `bond-electron/0.1.0`.

## Security notes

- This app can read files under the configured session root. Expanding to write or execute tools should be paired with explicit user approval and a clear workspace boundary.

## Dependencies

- **Runtime**: `@anthropic-ai/claude-agent-sdk`, `vue`.
- **Dev**: `electron`, `electron-vite`, `vite`, `typescript`, `@vitejs/plugin-vue`, `tailwindcss`, `vitest`, `@vue/test-utils`, `happy-dom`.

## Repository layout

```
src/
  main/              # Electron main + Agent SDK query loop
  preload/           # contextBridge API
  renderer/          # Vue 3 chat UI + Tailwind
    composables/     # State and logic (useChat)
    components/      # Vue components
    types/           # Shared renderer types (Message)
    lib/             # Utilities (highlight.js setup)
  shared/            # Shared stream chunk types
electron.vite.config.ts
vitest.config.ts
package.json
```
