# MCP strategy for Bond

The strongest strategy is to build a Bond-owned MCP layer using Pi extensions as the final tool-registration bridge. Existing Pi MCP extensions are valuable reference implementations, but neither is a clean drop-in for Bond's runtime.

Also, `context-a8c` is real—not a typo for Context7. `@automattic/mcp-context-a8c` is an Automattic MCP server for internal Linear, Slack, and P2 context. It runs over stdio, opens a WordPress.com OAuth flow, supports macOS system proxies, and delegates most behavior to `@automattic/mcp-wordpress-remote`.

## What Bond has today

The README claims MCP support, but it is not implemented yet.

The relevant runtime characteristics are:

- Bond deliberately disables automatic Pi extension discovery with `noExtensions: true` and injects only trusted factories in `src/daemon/pi/runtime.ts`.
- The active tool list is explicitly rebuilt and enforced each turn.
- Pi sessions are created and disposed for every Bond turn, even though their JSONL histories persist.
- Bond's approval layer recognizes only `bash`, `edit`, and `write`. An MCP tool that modifies Slack, Linear, GitHub, or WordPress would currently bypass approval checks.
- There are no MCP management RPCs or Settings UI yet.

Pi itself intentionally has no built-in MCP client. Its supported approach is an extension registering MCP tools through `pi.registerTool()`.

## The options

### 1. Embed `pi-mcp-adapter`

This is the best existing implementation to learn from. It currently supports:

- stdio, Streamable HTTP, and legacy SSE
- lazy connections and idle shutdown
- OAuth and bearer tokens
- cached tool metadata
- MCP resources exposed as tools
- one token-efficient `mcp` proxy tool
- optionally promoting selected MCP tools to first-class Pi tools

Its proxy design is especially relevant: instead of placing dozens or hundreds of MCP schemas into every model request, Bond exposes one tool with operations such as search, describe, and call.

However, it assumes a long-lived interactive Pi terminal session. Bond constructs and disposes a Pi session for every turn, so embedding it unchanged would repeatedly initialize and shut down MCP state. Its `/mcp` panels, terminal notifications, configuration discovery, and OAuth UI also do not map naturally to Bond's renderer and RPC layer.

**Verdict:** Excellent reference or vendored starting point, weak as an unchanged dependency.

Reference: <https://github.com/nicobailon/pi-mcp-adapter>

### 2. Embed `pi-mcp-extension`

`pi-mcp-extension` is smaller and more straightforward. It discovers MCP tools and registers each one as a native Pi tool. It supports stdio, Streamable HTTP, SSE, reconnection, cancellation, paginated tool discovery, and `tools/list_changed`.

This would likely produce the fastest technical proof:

```text
@automattic/mcp-context-a8c
        ↓ stdio
pi-mcp-extension
        ↓ registerTool
Pi
        ↓
Bond
```

But its default direct-tool approach can consume substantial context, and it has the same session-lifecycle and terminal-command assumptions. Its global configuration also lives under `~/.pi/agent`, while Bond intentionally isolates itself from normal Pi configuration.

**Verdict:** Good for a one-server prototype, not the product architecture.

Reference: <https://github.com/irahardianto/pi-mcp-extension>

### 3. Build a Bond-native MCP manager

This is the recommendation.

Use the official MCP TypeScript SDK for protocol handling and write a relatively thin Bond integration. The SDK already supplies clients for stdio and Streamable HTTP, along with `listTools`, `callTool`, resources, prompts, cancellation, and authentication support.

The key architectural separation should be:

```text
Settings / RPC
      ↓
Bond MCP manager — persistent for daemon lifetime
      ↓
MCP clients and server processes
      ↓
Bond-owned Pi extension factory
      ↓
one `mcp` proxy tool + selected promoted tools
```

This avoids coupling MCP connections to Bond's short-lived Pi session objects. The daemon manager can maintain lazy connections, subprocesses, OAuth state, health, and cached tool metadata across turns. Each new Pi session merely receives a lightweight extension backed by that manager.

It also gives Bond ownership over the parts that matter most:

- permissions and approvals
- server trust
- secret storage
- UI and connection status
- packaging
- tool naming
- result truncation
- transcript activity rendering
- connection lifecycle

**Verdict:** Slightly more initial work, but the right foundation.

Reference: <https://ts.sdk.modelcontextprotocol.io/client>

### 4. Use CLI wrappers and skills instead of MCP

Bond could expose servers through a CLI MCP client and teach the model to call it through `bash`. This matches Pi's minimalist philosophy and requires almost no Pi-specific integration.

It would sacrifice structured tool schemas, native activity rendering, precise approvals, image/resource handling, cancellation, and a user-friendly connection UI. Every operation would also look like shell execution to Bond.

**Verdict:** Useful as a temporary diagnostic path, not a user-facing MCP feature.

## Recommended design

### Tool exposure

Start with one first-class Pi tool:

```ts
mcp({
  action: "search" | "describe" | "call",
  server?: string,
  query?: string,
  tool?: string,
  arguments?: Record<string, unknown>
})
```

Then allow users or integrations to pin a small set of frequently used tools as direct tools. For example, Context A8C might promote its most useful search tool while leaving a large catalog behind the proxy.

This gives Bond low prompt overhead without sacrificing discoverability.

### Persistent manager

Create something like:

```text
src/daemon/mcp/
  config.ts
  manager.ts
  client.ts
  tools.ts
  permissions.ts
  content.ts
```

`manager.ts` should live for the daemon's lifetime, not the Pi session's lifetime. It should:

- lazily start stdio servers
- reuse live clients across Bond turns
- disconnect idle servers
- cache `tools/list`
- react to `tools/list_changed`
- propagate the turn's `AbortSignal`
- terminate subprocesses cleanly when the daemon exits

### Permissions

Do not route MCP through the current `requiresApproval()` test unchanged.

Each server should have a Bond policy such as:

```ts
type McpPolicy = {
  trust: "ask" | "trusted" | "disabled"
  readTools?: string[]
  writeTools?: string[]
  alwaysAskTools?: string[]
}
```

Use MCP annotations such as `readOnlyHint` and `destructiveHint` as hints, not as a security boundary—they are declarations supplied by the server.

A sensible initial policy would be:

- readonly mode: expose only explicitly approved read-only tools
- scoped mode: allow reads; ask before writes or open-world actions
- full mode: allow configured tools, but retain approval for destructive external actions
- unknown or unannotated tools: ask

"Full filesystem access" should not silently mean "permission to post to Slack or mutate Linear."

### Configuration and secrets

Bond should own a config under its application data directory or SQLite rather than reading arbitrary user Pi extensions. Store server definitions separately from credentials.

For example:

```json
{
  "name": "context-a8c",
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@automattic/mcp-context-a8c@0.2.2"
  ],
  "enabled": true
}
```

Secrets and OAuth tokens should go through macOS Keychain where Bond owns them. Context A8C is slightly different: its stdio package currently owns the WordPress.com OAuth flow and stores its own tokens, so Bond can initially treat it as a managed subprocess.

For a production release, pin its version or bundle it rather than execute an unpinned npm package whenever the user invokes it.

### Settings UI

Add an "MCP connections" section with:

- server list and health
- Add from JSON
- built-in Context A8C preset
- Connect/authenticate
- enable/disable
- discovered tool count
- per-tool approval/direct-tool controls
- stderr or connection-error diagnostics
- remove connection

Likely RPC surface:

```text
mcp.list
mcp.add
mcp.update
mcp.remove
mcp.connect
mcp.disconnect
mcp.authenticate
mcp.listTools
mcp.setToolPolicy
```

## Suggested delivery sequence

1. Build the persistent manager with stdio support and the single `mcp` proxy tool.
2. Add Context A8C as the first preset and verify its browser OAuth flow.
3. Require approval for every MCP call during the initial release.
4. Add Streamable HTTP and API-key/header support.
5. Add the Settings UI and Keychain-backed credentials.
6. Introduce read/write policy classification and promoted direct tools.
7. Later consider resources, prompts, MCP Apps/UI, sampling, and elicitation.

The first milestone can remain narrow: Context A8C, stdio, search/describe/call, persistent lifecycle, cancellation, and safe approvals. That proves the complete Bond experience without committing the product to another extension's terminal-specific architecture.

The useful code to borrow is primarily:

- lazy lifecycle and metadata cache from `pi-mcp-adapter`
- schema conversion, reconnection, pagination, and cancellation from `pi-mcp-extension`
- transport implementations from the official MCP TypeScript SDK
- OAuth/process expectations from `mcp-wordpress-remote`

Additional references:

- Pi extensions: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md>
- MCP TypeScript SDK: <https://ts.sdk.modelcontextprotocol.io/>
- MCP WordPress Remote: <https://github.com/Automattic/mcp-wordpress-remote>
