#!/usr/bin/env node

/**
 * bond operative — CLI for managing Bond operatives via the daemon.
 *
 * Usage:
 *   bond operative                              List all operatives
 *   bond operative ls                           Same as above
 *   bond operative ls --running                 Filter by status
 *   bond operative ls --completed               Filter by status
 *   bond operative ls --failed                  Filter by status
 *   bond operative ls --cancelled               Filter by status
 *   bond operative ls --queued                  Filter by status
 *   bond operative spawn "<prompt>"             Spawn with prompt (cwd = current directory)
 *   bond operative spawn "<prompt>" --dir <d>   Spawn with explicit working directory
 *   bond operative spawn "<prompt>" -w          Spawn with git worktree isolation
 *   bond operative spawn "<prompt>" --name <n>  Spawn with a display name
 *   bond operative spawn "<prompt>" --model <m> Spawn with model override
 *   bond operative spawn "<prompt>" --budget <$> Per-operative spend cap
 *   bond operative show <id|number>             Show operative details + recent events
 *   bond operative logs <id|number>             Stream events (tail -f style via WebSocket)
 *   bond operative cancel <id|number>           Cancel a running operative
 *   bond operative rm <id|number>               Delete an operative
 *   bond operative clear                        Delete all completed/failed operatives
 */

import { homedir } from 'node:os'
import { call, connect, WebSocket } from './connect'

// ANSI colors
const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const D = '\x1b[0;90m'
const S = '\x1b[9m'  // strikethrough
const N = '\x1b[0m'

interface Operative {
  id: string
  name: string
  prompt: string
  workingDir: string
  status: string
  sessionId?: string
  sdkSessionId?: string
  worktree?: string
  branch?: string
  model?: string
  resultSummary?: string
  errorMessage?: string
  exitCode?: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  timeoutMs?: number
  maxBudgetUsd?: number
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

interface OperativeEvent {
  id: number
  operativeId: string
  kind: string
  data: Record<string, unknown>
  createdAt: string
}

function findOperative(operatives: Operative[], query: string): Operative | undefined {
  // Try exact ID prefix match first
  const byId = operatives.find(o => o.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId
  // Try numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= operatives.length) return operatives[idx - 1]
  // Try case-insensitive name substring
  const lower = query.toLowerCase()
  return operatives.find(o => o.name.toLowerCase().includes(lower))
}

function abbreviatePath(p: string): string {
  const home = homedir()
  if (p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return `${mins}m ${remSecs}s`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hours}h ${remMins}m`
}

function getElapsed(op: Operative): string {
  if (op.status === 'running' && op.startedAt) {
    const elapsed = Date.now() - new Date(op.startedAt).getTime()
    return formatDuration(elapsed)
  }
  if (op.startedAt && op.completedAt) {
    const elapsed = new Date(op.completedAt).getTime() - new Date(op.startedAt).getTime()
    return formatDuration(elapsed)
  }
  if (op.status === 'queued') return 'queued'
  return ''
}

function statusIndicator(status: string): string {
  switch (status) {
    case 'running':   return `${G}●${N}`
    case 'completed': return `${G}✓${N}`
    case 'failed':    return `${R}✗${N}`
    case 'queued':    return `${D}○${N}`
    case 'cancelled': return `${D}–${N}`
    default:          return `${D}?${N}`
  }
}

function formatCost(costUsd: number): string {
  if (costUsd <= 0) return ''
  return `$${costUsd.toFixed(2)}`
}

function formatEvent(event: OperativeEvent): string | null {
  const time = new Date(event.createdAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const prefix = `${D}${time}${N}`

  switch (event.kind) {
    case 'assistant_text': {
      const text = (event.data.text as string) || ''
      return `${prefix}  ${text}`
    }
    case 'assistant_tool': {
      const name = (event.data.name as string) || 'tool'
      const summary = (event.data.summary as string) || ''
      return `${prefix}  ${Y}${name}${N}${summary ? `  ${D}${summary}${N}` : ''}`
    }
    case 'thinking_text':
      // Skip — too verbose for CLI
      return null
    case 'result': {
      const text = (event.data.text as string) || ''
      return `${prefix}  ${G}Completed${N}${text ? `  ${text}` : ''}`
    }
    case 'raw_error': {
      const text = (event.data.text as string) || (event.data.error as string) || 'Unknown error'
      return `${prefix}  ${R}Error:${N} ${text}`
    }
    case 'system': {
      const text = (event.data.text as string) || ''
      return `${prefix}  ${D}${text}${N}`
    }
    default:
      return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  const sub = args[0] || 'list'

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error(`${R}Cannot connect to daemon${N} — is Bond running?`)
    process.exit(1)
  }

  try {
    switch (sub) {
      case 'list':
      case 'ls': {
        // Parse status filter flags
        let statusFilter: string | undefined
        const rest = args.slice(1)
        for (const arg of rest) {
          if (arg === '--running') statusFilter = 'running'
          else if (arg === '--completed') statusFilter = 'completed'
          else if (arg === '--failed') statusFilter = 'failed'
          else if (arg === '--cancelled') statusFilter = 'cancelled'
          else if (arg === '--queued') statusFilter = 'queued'
        }

        const params: Record<string, unknown> = {}
        if (statusFilter) params.status = statusFilter

        const operatives = await call(ws, 'operative.list', params) as Operative[]

        if (operatives.length === 0) {
          const filterDesc = statusFilter ? ` with status "${statusFilter}"` : ''
          console.log(`${D}No operatives${filterDesc}${N}`)
          break
        }

        operatives.forEach((op, i) => {
          const num = String(i + 1).padStart(2, ' ')
          const indicator = statusIndicator(op.status)
          const name = op.name || op.prompt.slice(0, 50)
          const elapsed = getElapsed(op)
          const cost = formatCost(op.costUsd)
          const dir = abbreviatePath(op.workingDir)

          let line = `  ${D}${num}.${N}  ${indicator} ${name}  ${D}${op.status}${N}`
          if (elapsed && elapsed !== 'queued') line += `  ${D}${elapsed}${N}`
          if (cost) line += `  ${Y}${cost}${N}`
          line += `  ${D}${dir}${N}`

          console.log(line)
        })
        break
      }

      case 'spawn': {
        const rest = args.slice(1)

        // Parse flags
        let name: string | undefined
        let dir: string | undefined
        let model: string | undefined
        let budget: number | undefined
        let worktree = false
        const promptParts: string[] = []

        let i = 0
        while (i < rest.length) {
          const arg = rest[i]
          if (arg === '--name' || arg === '-n') {
            i++
            name = rest[i]
          } else if (arg === '--dir' || arg === '-d') {
            i++
            dir = rest[i]
          } else if (arg === '--model' || arg === '-m') {
            i++
            model = rest[i]
          } else if (arg === '--budget') {
            i++
            budget = parseFloat(rest[i])
            if (isNaN(budget)) {
              console.error(`${R}Invalid budget value:${N} ${rest[i]}`)
              process.exit(1)
            }
          } else if (arg === '-w' || arg === '--worktree') {
            worktree = true
          } else {
            promptParts.push(arg)
          }
          i++
        }

        const prompt = promptParts.join(' ')
        if (!prompt) {
          console.error(`${R}Usage:${N} bond operative spawn "<prompt>" [--name <n>] [--dir <d>] [-w] [--model <m>] [--budget <$>]`)
          process.exit(1)
        }

        const spawnParams: Record<string, unknown> = {
          prompt,
          name: name || prompt.slice(0, 50),
          workingDir: dir || process.cwd(),
        }
        if (worktree) spawnParams.worktree = true
        if (model) spawnParams.model = model
        if (budget !== undefined) spawnParams.maxBudgetUsd = budget

        const op = await call(ws, 'operative.spawn', spawnParams) as Operative

        console.log(`${G}Spawned${N}  ${op.name}`)
        console.log(`  ${D}ID:${N}     ${op.id.slice(0, 8)}`)
        console.log(`  ${D}Status:${N} ${op.status}`)
        console.log(`  ${D}Dir:${N}    ${abbreviatePath(op.workingDir)}`)
        if (op.model) console.log(`  ${D}Model:${N}  ${op.model}`)
        if (op.maxBudgetUsd) console.log(`  ${D}Budget:${N} $${op.maxBudgetUsd.toFixed(2)}`)
        if (op.worktree) console.log(`  ${D}Worktree:${N} ${abbreviatePath(op.worktree)}`)
        if (op.branch) console.log(`  ${D}Branch:${N} ${op.branch}`)
        break
      }

      case 'show': {
        const query = args.slice(1).join(' ')
        if (!query) {
          console.error(`${R}Usage:${N} bond operative show <id|number|name>`)
          process.exit(1)
        }

        const operatives = await call(ws, 'operative.list') as Operative[]
        const op = findOperative(operatives, query)
        if (!op) {
          console.error(`${R}No matching operative:${N} ${query}`)
          process.exit(1)
        }

        // Header
        console.log(`\n  ${statusIndicator(op.status)} ${op.name}`)
        console.log(`  ${D}${'─'.repeat(40)}${N}`)
        console.log(`  ${D}ID:${N}     ${op.id.slice(0, 8)}`)
        console.log(`  ${D}Status:${N} ${op.status}`)
        console.log(`  ${D}Dir:${N}    ${abbreviatePath(op.workingDir)}`)
        if (op.model) console.log(`  ${D}Model:${N}  ${op.model}`)

        const elapsed = getElapsed(op)
        if (elapsed) console.log(`  ${D}Time:${N}   ${elapsed}`)

        const cost = formatCost(op.costUsd)
        if (cost) console.log(`  ${D}Cost:${N}   ${cost}`)

        if (op.worktree) console.log(`  ${D}Worktree:${N} ${abbreviatePath(op.worktree)}`)
        if (op.branch) console.log(`  ${D}Branch:${N} ${op.branch}`)
        if (op.resultSummary) console.log(`\n  ${G}Result:${N} ${op.resultSummary}`)
        if (op.errorMessage) console.log(`\n  ${R}Error:${N} ${op.errorMessage}`)

        // Recent events
        const events = await call(ws, 'operative.events', { id: op.id, limit: 50 }) as OperativeEvent[]
        if (events.length > 0) {
          console.log(`\n  ${D}Recent events:${N}`)
          for (const event of events) {
            const line = formatEvent(event)
            if (line) console.log(`  ${line}`)
          }
        }

        console.log('')
        break
      }

      case 'logs': {
        const query = args.slice(1).join(' ')
        if (!query) {
          console.error(`${R}Usage:${N} bond operative logs <id|number|name>`)
          process.exit(1)
        }

        const operatives = await call(ws, 'operative.list') as Operative[]
        const op = findOperative(operatives, query)
        if (!op) {
          console.error(`${R}No matching operative:${N} ${query}`)
          process.exit(1)
        }

        console.log(`${D}Streaming events for${N} ${op.name} ${D}(${op.id.slice(0, 8)})${N}\n`)

        // Print existing events first
        const events = await call(ws, 'operative.events', { id: op.id }) as OperativeEvent[]
        for (const event of events) {
          const line = formatEvent(event)
          if (line) console.log(line)
        }

        // If already finished, exit
        if (op.status === 'completed' || op.status === 'failed' || op.status === 'cancelled') {
          console.log(`\n${D}Operative ${op.status}.${N}`)
          break
        }

        // Stream new events via WebSocket notifications
        let lastEventId = events.length > 0 ? events[events.length - 1].id : 0

        await new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.Data) => {
            const parsed = JSON.parse(data.toString())

            // JSON-RPC notification (no id field)
            if (!parsed.id && parsed.method) {
              if (parsed.method === 'operative.event') {
                const payload = parsed.params as { operativeId: string; event: OperativeEvent }
                if (payload.operativeId === op.id && payload.event.id > lastEventId) {
                  lastEventId = payload.event.id
                  const line = formatEvent(payload.event)
                  if (line) console.log(line)
                }
              }

              if (parsed.method === 'operative.changed') {
                // Re-fetch status to check if operative finished
                call(ws, 'operative.get', { id: op.id }).then((result) => {
                  const updated = result as Operative
                  if (updated.status === 'completed' || updated.status === 'failed' || updated.status === 'cancelled') {
                    console.log(`\n${D}Operative ${updated.status}.${N}`)
                    ws.off('message', onMessage)
                    resolve()
                  }
                })
              }
            }
          }

          ws.on('message', onMessage)
        })
        break
      }

      case 'cancel': {
        const query = args.slice(1).join(' ')
        if (!query) {
          console.error(`${R}Usage:${N} bond operative cancel <id|number|name>`)
          process.exit(1)
        }

        const operatives = await call(ws, 'operative.list') as Operative[]
        const op = findOperative(operatives, query)
        if (!op) {
          console.error(`${R}No matching operative:${N} ${query}`)
          process.exit(1)
        }

        await call(ws, 'operative.cancel', { id: op.id })
        console.log(`${Y}Cancelled${N}  ${op.name}`)
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const query = args.slice(1).join(' ')
        if (!query) {
          console.error(`${R}Usage:${N} bond operative rm <id|number|name>`)
          process.exit(1)
        }

        const operatives = await call(ws, 'operative.list') as Operative[]
        const op = findOperative(operatives, query)
        if (!op) {
          console.error(`${R}No matching operative:${N} ${query}`)
          process.exit(1)
        }

        await call(ws, 'operative.remove', { id: op.id })
        console.log(`${R}Deleted${N}  ${op.name}`)
        break
      }

      case 'clear': {
        const result = await call(ws, 'operative.clear') as { deleted: number }
        if (result.deleted === 0) {
          console.log(`${D}No completed/failed operatives to clear${N}`)
        } else {
          console.log(`${R}Cleared${N} ${result.deleted} operative${result.deleted === 1 ? '' : 's'}`)
        }
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond operative [ls|spawn|show|logs|cancel|rm|clear] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
