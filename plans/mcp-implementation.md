# MCP implementation plan

Companion to `mcp-strategy.md`. That doc decided **what** (Bond-native manager, one `mcp` proxy tool, approvals from day one). This doc is the **how** — milestones, files, seams, and tests, grounded in the actual code.

## Architecture (one paragraph)

A daemon-lifetime **manager** (`src/daemon/mcp/manager.ts`) owns MCP connections, subprocesses, and cached tool catalogs — same shape as the web render broker (`web/broker.ts`), which already proves the pattern: persistent daemon state fronted by a thin per-turn Pi extension. Each Bond turn gets a throwaway extension factory (like `createWebExtensionFactory` in `web/tools.ts`) that registers ONE `mcp` tool forwarding to the manager. Every `call` action requests human approval through the existing `approvals.ts` registry before executing.

## Decisions already made

1. **Proxy tool only in v1** — one `mcp(action, …)` tool, no per-tool schemas in the prompt. Promoted direct tools come in M5.
2. **Approvals ship in M1, not later.** Today's gate (`requiresApproval()` in `pi/runtime.ts:60`) only knows `bash`/`edit`/`write`, and full mode skips it entirely (`runtime.ts:383`). MCP gets its own gate inside the tool's `execute` — every `call` prompts, in every edit mode.
3. **Readonly mode excludes the `mcp` tool entirely** (v1). Scoped and full include it, with per-call prompts. Read/write policy classification relaxes this in M5.
4. **MCP tools never join the `requiredBondTools` hard-fail check** (`runtime.ts:427`). A down MCP server degrades to "tool reports the server is unavailable" — it must never kill a turn.
5. **Config in the settings KV store** (`mcp.servers` JSON via `getSetting`/`setSetting`), typed accessors in `mcp/config.ts`. No credentials in it — Context A8C owns its own OAuth tokens for now; Keychain lands in M4.
6. **Official `@modelcontextprotocol/sdk`** for protocol + transports. Pure TS, bundles fine with the daemon's esbuild. Its `InMemoryTransport` is the test harness.

---

## Milestone 1 — manager + proxy tool + approvals (the shippable core)

**Goal:** the model can search, describe, and call tools on a configured stdio MCP server; every call prompts for approval; a dead server never breaks chat.

### New files (each gets a `.test.ts` sibling)

```
src/daemon/mcp/
  config.ts      # McpServerConfig type + getMcpServers()/setMcpServers() over settings KV
  client.ts      # One server connection: SDK Client + StdioClientTransport, connect/close, listTools, callTool
  manager.ts     # Daemon-lifetime registry: lazy connect, client reuse, idle disconnect, tools/list cache, shutdown
  tools.ts       # createMcpExtensionFactory() — registers the `mcp` Pi tool, approval gate
  content.ts     # MCP result → tool result: text extraction, truncation cap, image/resource placeholders
```

### Shapes

```ts
// config.ts
export interface McpServerConfig {
  id: string                 // slug, unique
  name: string               // display name
  transport: 'stdio'         // 'http' joins in M4
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}
```

```ts
// manager.ts — module-level singleton, like web/broker.ts
export interface McpToolInfo { server: string; name: string; description: string; inputSchema: unknown }
export function listCatalog(): Promise<McpToolInfo[]>           // lazy-connects enabled servers, serves cache
export function searchCatalog(query?: string): Promise<McpToolInfo[]>  // token match on name+description
export function describeTool(server: string, tool: string): Promise<McpToolInfo>
export function callTool(server: string, tool: string, args: unknown, signal: AbortSignal): Promise<CallToolResult>
export function serverStatuses(): McpServerStatus[]             // for /health, CLI, later UI
export function shutdownMcp(): Promise<void>                    // kill subprocesses; called from daemon exit path
```

Manager behavior:
- **Lazy:** nothing spawns at daemon boot. First catalog/call touching a server connects it.
- **Warm:** clients live across turns (the whole point). Idle timer (default 5 min) disconnects; next use reconnects.
- **Cached:** `tools/list` cached per server; invalidated by `tools/list_changed` notification and on reconnect.
- **Contained:** a server that fails to spawn/connect is marked errored with the message; catalog calls still succeed for healthy servers; `call` against an errored server returns a structured error, never throws past the tool.

### The `mcp` tool (tools.ts)

Registered via `pi.registerTool` exactly like `web/tools.ts` (same TypeBox `Type.Object` parameter style, same structured-`{ error }`-not-throw result convention):

```ts
mcp({
  action: 'search' | 'describe' | 'call',
  server?: string, query?: string, tool?: string, arguments?: object
})
```

- `search` → name/description matches across all enabled servers (no approval).
- `describe` → full input schema for one tool (no approval).
- `call` → **approval first**: mint `requestId`, emit a `tool_approval` chunk (`toolName: 'mcp'`, input carries server/tool/args, title like `Allow context-a8c: search_p2?`), await `registerApproval(requestId, turnId)`. Denied → structured "user denied" result. The existing renderer `ApprovalPrompt`, `approval_resolved` multi-device sync, and `clearTurnApprovals` on abort all work unchanged — they key on requestId/turnId, not tool names.

Factory is per-turn: `createMcpExtensionFactory({ turnId, onChunk, abortSignal })` — all three already live on `runPiBondQuery`'s options. The abort signal flows into `manager.callTool` for MCP-side cancellation.

### Integration edits

1. `pi/runtime.ts` — add the factory to `extensionFactories` (line 360 block); add `MCP_TOOL_NAMES` (`['mcp']`) to `toolsForEditMode` for full + scoped only. **Do not** add to `requiredBondTools`.
2. `main.ts` — `await shutdownMcp()` on the exit path so stdio subprocesses die with the daemon.
3. `lib/format.ts` (renderer) — tool label formatter: `mcp` + input → `context-a8c: search_p2` so TurnActivity rows read well. (TurnActivity itself needs no changes; tool chunks are generic.)
4. `package.json` — add `@modelcontextprotocol/sdk`.

### Tests

- `config.test.ts` — round-trip, bad JSON tolerance.
- `client.test.ts` / `manager.test.ts` — `InMemoryTransport` linked client/server pairs: lazy connect, cache, list_changed invalidation, idle disconnect (fake timers), errored-server containment, shutdown kills all.
- `tools.test.ts` — fake `ExtensionAPI` (pattern from web tools tests): search/describe need no approval; call parks an approval and blocks until resolved; deny returns denied result; abort clears; down server returns error result.
- `content.test.ts` — truncation cap (follow web tools' ~20k char budget), image content → `[image omitted]` placeholder.
- Regression: turn completes normally when the only configured server's command doesn't exist.

**Done when:** with a server hand-added to settings, asking Bond to use it produces search → describe → approval prompt → call → rendered result in TurnActivity; killing the server process mid-conversation degrades gracefully; `npm run test:run` passes.

---

## Milestone 2 — Context A8C preset + CLI + minimal RPCs

**Goal:** the real first server works end to end, manageable without UI.

1. **Preset** in `config.ts`: `context-a8c` → `npx -y @automattic/mcp-context-a8c@<pinned>` (pin the version; bundling can wait for packaging work). Its stdio process owns the WordPress.com browser OAuth flow — Bond just spawns it and surfaces stderr in server status for diagnosing auth failures.
2. **RPCs** in `shared/rpc-schema.ts` (+ `RPC_METHOD_NAMES`, handlers in `server.ts` next to the `settings.*` block): `mcp.list`, `mcp.add`, `mcp.update`, `mcp.remove`, `mcp.listTools`, `mcp.status`. **Bump `PROTOCOL_VERSION`** (equality = compatibility) and rebuild the web bundle. `window.bond` proxies come free via `buildDaemonSurface`.
3. **CLI**: `bin/bond mcp list|add|remove|enable|disable|tools|status` — new `src/cli/mcp.ts` on the existing `connect.ts` socket pattern, added to `build:cli`. This is the dev/test surface until M3.
4. Rollout note: daemon changes need `bin/bond rebuild daemon`; protocol bump means desktop app relaunch too.

**Done when:** `bin/bond mcp add context-a8c` → OAuth completes → asking Bond "search P2 for X" round-trips with approval.

---

## Milestone 3 — Settings UI

**Goal:** "MCP connections" section in `SettingsView.vue` (or a dedicated view if it outgrows a section).

- Server list with status dot (connected / idle / errored / disabled), discovered tool count, last error text.
- Add from JSON paste + the Context A8C preset button.
- Enable/disable toggle, remove (confirm), reconnect.
- Per existing conventions: `BondButton`/`BondInput`/`BondSelect`/`BondText` only, design tokens only, component tests for the new pieces, `collections.changed`-style push notification (`mcp.changed`) so open windows refresh.

---

## Milestone 4 — Streamable HTTP + secrets

- `transport: 'http'` in `McpServerConfig` (URL + optional headers) using the SDK's `StreamableHTTPClientTransport`.
- Header/API-key credentials move to macOS Keychain (`security` CLI or `keytar`-equivalent); config stores a credential *reference*, never the secret. Settings UI gets a token field that writes through to Keychain.
- SDK OAuth support for HTTP servers is scoped here **only if** a target server needs it; otherwise defer.

## Milestone 5 — policy engine + promoted tools

- `McpPolicy` per server (`trust: ask|trusted|disabled`, read/write/alwaysAsk tool lists) stored beside the server config; `readOnlyHint`/`destructiveHint` annotations pre-fill the classification but a human confirms — annotations are server-supplied, not a security boundary.
- Edit-mode mapping: readonly exposes approved read-only tools; scoped auto-allows reads, prompts writes; full still prompts for destructive/unknown. Replaces M1's blanket prompt-everything.
- Promoted tools: user pins catalog tools → registered as first-class Pi tools (name-prefixed `mcp__server__tool`), joining `toolsForEditMode` per their classification.
- Per-tool controls land in the M3 UI.

## Milestone 6 — later

Resources, prompts, MCP Apps/UI, sampling, elicitation, `wire-debug.ts` assertions for promoted-tool manifests. Nothing here blocks earlier milestones.

---

## Sizing

| Milestone | Estimate |
|---|---|
| M1 core | ~1 day incl. tests |
| M2 preset/CLI/RPCs | ~half day |
| M3 Settings UI | ~half day |
| M4 HTTP + Keychain | ~half day |
| M5 policy + promoted | ~1 day |

## Open items (non-blocking)

- Verify the exact pinned `@automattic/mcp-context-a8c` version at M2 time.
- Confirm whether Pi's `execute` receives an abort signal directly; if so, prefer it over the captured turn signal.
- Packaged-app check at M2: `npx` resolution relies on the login-shell PATH work already in `src/main/index.ts` — verify inside a packaged build.
