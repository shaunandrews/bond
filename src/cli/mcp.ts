#!/usr/bin/env node

/**
 * bond mcp — manage Bond's MCP server connections.
 *
 * Usage:
 *   bond mcp list                            Configured servers + available presets
 *   bond mcp status                          Live connection state per server
 *   bond mcp add <preset>                    Add a preset (e.g. context-a8c)
 *   bond mcp add <id> <command> [args…]      Add a stdio server by command line
 *   bond mcp add --json '{"id":…}'           Add from a pasted JSON config
 *   bond mcp enable|disable <id>             Toggle a server
 *   bond mcp reconnect <id>                  Drop the connection; next use respawns
 *   bond mcp remove <id>                     Delete a server
 *   bond mcp tools [id] [query]              Discovered tools (connects on demand)
 *   bond mcp trust <id> <ask|trusted|disabled>   Set how much a server is trusted
 *   bond mcp classify <id> <tool[:route]> <read|write|ask>   Confirm what a tool does
 *                                            (route scopes a proxy tool, e.g. execute-tool:linear)
 *   bond mcp ask <id> <tool> [off]           Always prompt for one tool
 *   bond mcp promote <id> <tool> [off]       Pin a tool as a first-class Bond tool
 *   bond mcp secret set <ref> [value]        Store a token in the macOS Keychain
 *   bond mcp secret rm <ref>                 Delete a stored token
 *   bond mcp secret list                     Stored token names (never values)
 */

import { call, connect, WebSocket } from './connect'

const D = '\x1b[0;90m'
const N = '\x1b[0m'
const B = '\x1b[1m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const R = '\x1b[0;31m'

interface Policy {
  trust: 'ask' | 'trusted' | 'disabled'
  read: string[]
  write: string[]
  alwaysAsk: string[]
  promoted: string[]
}

interface ServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url?: string
  enabled: boolean
  policy: Policy
}

interface ServerPreset {
  id: string
  name: string
  description: string
  command: string
  args: string[]
}

interface ServerStatus {
  id: string
  name: string
  enabled: boolean
  transport: string
  state: string
  toolCount: number
  trust: string
  secretRefs: string[]
  error?: string
  stderr?: string
}

interface ToolInfo {
  server: string
  name: string
  description: string
  toolClass: 'read' | 'write' | 'unknown'
  suggestedClass: 'read' | 'write' | 'unknown'
  alwaysAsk: boolean
  promoted: boolean
}

const STATE_COLOR: Record<string, string> = {
  connected: G,
  connecting: Y,
  error: R,
  disabled: D,
  disconnected: D,
}

function describeEndpoint(server: ServerConfig): string {
  return server.transport === 'http' ? (server.url ?? '(no url)') : `${server.command} ${server.args.join(' ')}`.trim()
}

/** `off`/`false`/`no` turns a toggle off; anything else (including nothing) turns it on. */
function toggleValue(word: string | undefined): boolean {
  return !(word === 'off' || word === 'false' || word === 'no')
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let buffer = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { buffer += chunk })
    process.stdin.on('end', () => resolve(buffer.trim()))
  })
}

async function cmdSecret(ws: WebSocket, args: string[]): Promise<void> {
  const [action, ref, ...rest] = args
  switch (action) {
    case 'set': {
      if (!ref) throw new Error('Usage: bond mcp secret set <ref> [value]   (or pipe the value on stdin)')
      // Prefer stdin so a token need not land in shell history.
      const value = rest.join(' ') || await readStdin()
      if (!value) throw new Error('No value provided. Pipe it in: echo "token" | bond mcp secret set my-token')
      await call(ws, 'mcp.setSecret', { ref, value })
      console.log(`${G}Stored ${ref} in the Keychain${N}`)
      console.log(`${D}Reference it in a config as "keychain:${ref}" — e.g. headers.Authorization = "Bearer keychain:${ref}"${N}`)
      break
    }
    case 'rm':
    case 'remove': {
      if (!ref) throw new Error('Usage: bond mcp secret rm <ref>')
      const { ok } = await call(ws, 'mcp.deleteSecret', { ref }) as { ok: boolean }
      console.log(ok ? `${Y}Removed ${ref}${N}` : `${D}No stored secret called ${ref}${N}`)
      break
    }
    case 'list':
    case undefined: {
      const { refs } = await call(ws, 'mcp.listSecrets') as { refs: string[] }
      if (!refs.length) return console.log(`${D}No MCP secrets stored.${N}`)
      for (const stored of refs) console.log(`  ${G}${stored}${N}  ${D}keychain:${stored}${N}`)
      break
    }
    default:
      throw new Error(`Unknown secret command "${action}" (use set | rm | list)`)
  }
}

function usage(): never {
  console.log(`${B}bond mcp${N} — MCP server connections

  ${G}list${N}                          Configured servers and available presets
  ${G}status${N}                        Live connection state per server
  ${G}add${N} <preset>                  Add a preset by id
  ${G}add${N} <id> <command> [args…]    Add a stdio server by command line
  ${G}add${N} --json '<config>'         Add from a pasted JSON config
  ${G}enable|disable${N} <id>           Toggle a server
  ${G}reconnect${N} <id>                Drop the connection; next use respawns
  ${G}remove${N} <id>                   Delete a server
  ${G}tools${N} [id] [query]            Discovered tools (connects on demand)
  ${G}trust${N} <id> <ask|trusted|disabled>
                                How much this server is trusted (default: ask)
  ${G}classify${N} <id> <tool[:route]> <read|write|ask>
                                Confirm what a tool does — drives auto-approval.
                                Scope a proxy tool per provider: execute-tool:linear
  ${G}ask${N} <id> <tool> [off]         Always prompt for this tool, even when trusted
  ${G}promote${N} <id> <tool> [off]     Pin a tool as a first-class Bond tool
  ${G}secret${N} set|rm|list [ref]      Keychain-backed tokens (values are never read back)`)
  process.exit(0)
}

async function cmdList(ws: WebSocket): Promise<void> {
  const { servers, presets } = await call(ws, 'mcp.list') as { servers: ServerConfig[]; presets: ServerPreset[] }
  if (!servers.length) {
    console.log(`${D}No MCP servers configured.${N}`)
  } else {
    for (const server of servers) {
      const flag = server.enabled ? `${G}enabled${N}` : `${D}disabled${N}`
      console.log(`${B}${server.id}${N}  ${flag}  ${D}trust: ${server.policy.trust}${N}`)
      console.log(`  ${D}${describeEndpoint(server)}${N}`)
      if (server.policy.promoted.length) console.log(`  ${D}pinned: ${server.policy.promoted.join(', ')}${N}`)
    }
  }
  const unused = presets.filter((preset) => !servers.some((server) => server.id === preset.id))
  if (unused.length) {
    console.log(`\n${D}Available presets — add with \`bond mcp add <id>\`:${N}`)
    for (const preset of unused) console.log(`  ${G}${preset.id}${N}  ${D}${preset.description}${N}`)
  }
}

async function cmdStatus(ws: WebSocket): Promise<void> {
  const { servers } = await call(ws, 'mcp.status') as { servers: ServerStatus[] }
  if (!servers.length) return console.log(`${D}No MCP servers configured.${N}`)
  for (const server of servers) {
    const color = STATE_COLOR[server.state] ?? N
    console.log(`${B}${server.id}${N}  ${color}${server.state}${N}  ${D}${server.transport} · ${server.toolCount} tools · trust: ${server.trust}${N}`)
    if (server.secretRefs.length) console.log(`  ${D}keychain: ${server.secretRefs.join(', ')}${N}`)
    if (server.error) console.log(`  ${R}${server.error}${N}`)
    if (server.stderr) console.log(`  ${D}stderr: ${server.stderr.split('\n').slice(-3).join(' / ')}${N}`)
  }
}

async function cmdAdd(ws: WebSocket, args: string[]): Promise<void> {
  if (args[0] === '--json') {
    const payload = args.slice(1).join(' ')
    if (!payload) throw new Error('Provide a JSON config after --json')
    const server = await call(ws, 'mcp.add', { server: JSON.parse(payload) }) as ServerConfig
    return console.log(`${G}Added ${server.id}${N}`)
  }

  const [id, command, ...rest] = args
  if (!id) throw new Error('Usage: bond mcp add <preset> | <id> <command> [args…] | <id> --url <endpoint>')

  if (command === '--url') {
    const url = rest[0]
    if (!url) throw new Error('Usage: bond mcp add <id> --url https://host/mcp [--header "Name: keychain:ref"]')
    const headers: Record<string, string> = {}
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] !== '--header') continue
      const [name, ...valueParts] = (rest[index + 1] ?? '').split(':')
      if (name && valueParts.length) headers[name.trim()] = valueParts.join(':').trim()
    }
    const server = await call(ws, 'mcp.add', {
      server: { id, name: id, transport: 'http', url, headers, enabled: true },
    }) as ServerConfig
    console.log(`${G}Added ${server.id}${N}  ${D}${server.url}${N}`)
    return
  }

  if (!command) {
    // A bare id means "add this preset" — the only way to get one without a command line.
    const server = await call(ws, 'mcp.add', { preset: id }) as ServerConfig
    console.log(`${G}Added ${server.id}${N}  ${D}${server.command} ${server.args.join(' ')}${N}`)
    console.log(`${D}It connects on first use — run \`bond mcp tools ${server.id}\` to try it now.${N}`)
    return
  }

  const server = await call(ws, 'mcp.add', { server: { id, name: id, command, args: rest, enabled: true } }) as ServerConfig
  console.log(`${G}Added ${server.id}${N}  ${D}${server.command} ${server.args.join(' ')}${N}`)
}

async function cmdTools(ws: WebSocket, args: string[]): Promise<void> {
  const [server, ...queryParts] = args
  const result = await call(ws, 'mcp.listTools', {
    server: server || undefined,
    query: queryParts.join(' ') || undefined,
  }) as { tools: ToolInfo[]; errors: Array<{ server: string; error: string }> }

  if (!result.tools.length) console.log(`${D}No tools found.${N}`)
  let lastServer = ''
  for (const tool of result.tools) {
    if (tool.server !== lastServer) {
      console.log(`\n${B}${tool.server}${N}`)
      lastServer = tool.server
    }
    const marks = [
      tool.toolClass === 'unknown' ? `${Y}unclassified${N}` : `${D}${tool.toolClass}${N}`,
      tool.alwaysAsk ? `${Y}always-ask${N}` : '',
      tool.promoted ? `${G}pinned${N}` : '',
      tool.toolClass === 'unknown' && tool.suggestedClass !== 'unknown' ? `${D}(server says ${tool.suggestedClass})${N}` : '',
    ].filter(Boolean).join(' ')
    console.log(`  ${G}${tool.name}${N}  ${marks}`)
    console.log(`    ${D}${tool.description.split('\n')[0].slice(0, 96)}${N}`)
  }
  for (const error of result.errors) {
    console.error(`${R}${error.server}: ${error.error}${N}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sub = args[0] || 'list'
  if (sub === 'help' || sub === '-h' || sub === '--help') usage()

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error('Cannot connect to Bond daemon. Is it running?')
    process.exit(1)
  }

  try {
    switch (sub) {
      case 'list':
        await cmdList(ws)
        break
      case 'status':
        await cmdStatus(ws)
        break
      case 'add':
        await cmdAdd(ws, args.slice(1))
        break
      case 'enable':
      case 'disable': {
        const id = args[1]
        if (!id) throw new Error(`Usage: bond mcp ${sub} <id>`)
        await call(ws, 'mcp.update', { id, updates: { enabled: sub === 'enable' } })
        console.log(`${G}${id} ${sub}d${N}`)
        break
      }
      case 'reconnect': {
        const id = args[1]
        if (!id) throw new Error('Usage: bond mcp reconnect <id>')
        await call(ws, 'mcp.reconnect', { id })
        console.log(`${G}${id} will reconnect on next use${N}`)
        break
      }
      case 'remove':
      case 'rm': {
        const id = args[1]
        if (!id) throw new Error('Usage: bond mcp remove <id>')
        const { ok } = await call(ws, 'mcp.remove', { id }) as { ok: boolean }
        console.log(ok ? `${Y}Removed ${id}${N}` : `${D}No server called ${id}${N}`)
        break
      }
      case 'tools':
        await cmdTools(ws, args.slice(1))
        break
      case 'trust': {
        const [id, trust] = args.slice(1)
        if (!id || !trust) throw new Error('Usage: bond mcp trust <id> <ask|trusted|disabled>')
        await call(ws, 'mcp.setTrust', { id, trust })
        console.log(`${G}${id} trust: ${trust}${N}`)
        if (trust === 'trusted') console.log(`${D}Confirmed read tools now run without asking. Classify them with \`bond mcp classify\`.${N}`)
        break
      }
      case 'classify': {
        const [id, tool, word] = args.slice(1)
        if (!id || !tool || !word) throw new Error('Usage: bond mcp classify <id> <tool> <read|write|ask>')
        const toolClass = word === 'ask' ? 'unknown' : word
        if (toolClass !== 'read' && toolClass !== 'write' && toolClass !== 'unknown') {
          throw new Error('Classification must be read, write, or ask')
        }
        await call(ws, 'mcp.classifyTool', { id, tool, toolClass })
        console.log(`${G}${id}:${tool} → ${word}${N}`)
        break
      }
      case 'ask': {
        const [id, tool, word] = args.slice(1)
        if (!id || !tool) throw new Error('Usage: bond mcp ask <id> <tool> [off]')
        const alwaysAsk = toggleValue(word)
        await call(ws, 'mcp.setAlwaysAsk', { id, tool, alwaysAsk })
        console.log(`${G}${id}:${tool} ${alwaysAsk ? 'always asks' : 'follows the server policy'}${N}`)
        break
      }
      case 'promote': {
        const [id, tool, word] = args.slice(1)
        if (!id || !tool) throw new Error('Usage: bond mcp promote <id> <tool> [off]')
        const promoted = toggleValue(word)
        await call(ws, 'mcp.promoteTool', { id, tool, promoted })
        console.log(`${G}${id}:${tool} ${promoted ? 'pinned as a first-class tool' : 'unpinned'}${N}`)
        break
      }
      case 'secret':
        await cmdSecret(ws, args.slice(1))
        break
      default:
        usage()
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(`\x1b[0;31m${err.message || err}\x1b[0m`)
  process.exit(1)
})
