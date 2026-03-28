# Bond

Bond is a local Electron app that chats with an agent powered by the [**Claude Agent SDK**](https://platform.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`). The MVP focuses on **read-only** access to files on your machine: **Read**, **Glob**, and **Grep**, with the agent session rooted at your **home directory** so paths like `~/Documents/file.txt` are valid.

## Requirements

- **Node.js 18+**
- **Anthropic API access** — typically an API key from the [Claude Console](https://console.anthropic.com/). API usage is billed separately from most **claude.ai** web subscriptions; check Anthropic’s current pricing and terms. The SDK may also support other auth paths (for example flows tied to the Claude Code runtime); see the [Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview) for your version.

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY
npm run dev
```

## Scripts

| Script            | Description                                      |
| ----------------- | ------------------------------------------------ |
| `npm run dev`     | Development: electron-vite dev server + Electron |
| `npm run build`   | Production build into `out/`                     |
| `npm run preview` | Run electron-vite preview                          |

After a build, you can run the packaged main entry with:

```bash
npx electron .
```

(`package.json` `"main"` points to `./out/main/index.js`.)

## Configuration

- **`.env`** (optional but expected for API key auth): `ANTHROPIC_API_KEY=...`
- **`dotenv`** loads `.env` from the **current working directory** when the app starts (`src/main/index.ts`), with quiet logging.

## Architecture

Bond follows the usual Electron split so the Agent SDK never runs in the renderer:

1. **Main process** (`src/main/`)
   - Creates the window, loads the renderer (dev URL or `out/renderer/index.html`).
   - Handles IPC: `bond:send` (run a user prompt through the SDK), `bond:cancel` (abort the active run).
   - **`agent.ts`** calls `query()` from `@anthropic-ai/claude-agent-sdk`, streams `SDKMessage` values, and maps them to small **chunk** objects for the UI.

2. **Preload** (`src/preload/index.ts`)
   - Exposes `window.bond`: `send`, `cancel`, `onChunk` (subscribe to `bond:chunk` events).

3. **Renderer** (`src/renderer/`)
   - Vanilla TypeScript + CSS chat UI; no Node integration in the page.

4. **Shared types** (`src/shared/stream.ts`)
   - `BondStreamChunk` — serializable stream events shared between main, preload typing, and renderer.

### Build tooling

- **electron-vite** builds three targets: `out/main`, `out/preload` (ESM preload as `index.mjs`), `out/renderer`.
- With `"type": "module"`, the main window preload path is **`../preload/index.mjs`** (see `src/main/index.ts`).

## Agent behavior (MVP)

- **`cwd`**: [`os.homedir()`](https://nodejs.org/api/os.html#oshomedir) — agent file tools are scoped relative to that session root (plus any SDK defaults for “additional” paths; see SDK docs).
- **`allowedTools`**: `Read`, `Glob`, `Grep` only — no writes or shell commands in this MVP.
- **`permissionMode`**: `acceptEdits` — aligns with the SDK’s permission model for smoother tool use; edits are not exposed via `allowedTools` here.
- **`systemPrompt`**: Short identity/instruction string for “Bond” and path hints.
- **`CLAUDE_AGENT_SDK_CLIENT_APP`**: Set to `bond-electron/0.1.0` for SDK client identification.

Streaming errors and auth status messages from the SDK are surfaced in the chat when mapped in `bondMessageToChunks()` in `src/main/agent.ts`.

## Security notes

- This app can read files under the configured session root. Treat **API keys** and **`.env`** like secrets; add `.env` to `.gitignore` (already ignored in this repo).
- Expanding to **write** or **execute** tools (`Edit`, `Bash`, etc.) should be paired with explicit **user approval** (`canUseTool` / permission modes) and a clear **workspace boundary**, not unbounded home-directory access.

## Dependencies (high level)

- **Runtime**: `@anthropic-ai/claude-agent-sdk`, `dotenv`, `zod` (peer of the SDK).
- **Dev**: `electron`, `electron-vite`, `vite`, `typescript`, `@types/node`.

## Repository layout

```
src/
  main/           # Electron main + Agent SDK query loop
  preload/        # contextBridge API
  renderer/       # Chat UI
  shared/         # Shared stream chunk types
electron.vite.config.ts
package.json
.env.example
```

---

*Last documented: project MVP as of the initial Bond + Claude Agent SDK integration.*
