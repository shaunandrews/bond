#!/usr/bin/env node

/**
 * bond sense — CLI for Sense ambient awareness and memory.
 *
 * Usage:
 *   bond sense                                Status
 *   bond sense on                             Enable Sense
 *   bond sense off                            Disable Sense
 *   bond sense pause [minutes]                Pause for N minutes (default 10)
 *   bond sense resume                         Resume from pause
 *   bond sense now                            Current screen context
 *   bond sense today                          Today's summary
 *   bond sense yesterday                      Yesterday's summary
 *   bond sense week                           Weekly summary
 *   bond sense search <query>                 Cross-channel search (see + chat + facts)
 *   bond sense apps [today|week]              App usage breakdown
 *   bond sense timeline [range]               Chronological activity
 *   bond sense memory                         Recent debriefs + active facts
 *   bond sense threads                        Open threads from recent sessions
 *   bond sense decisions                      Recent decisions
 *   bond sense debrief <session-id>           Full debrief detail
 *   bond sense remember <fact>                Pin a fact
 *   bond sense facts                          List active facts
 *   bond sense forget <id|number>             Deactivate a fact
 *   bond sense backfill [--limit N]           Generate debriefs for old sessions
 *   bond sense exclude <bundleId>             Add app to blacklist
 *   bond sense include <bundleId>             Remove app from blacklist
 *   bond sense excluded                       List blacklisted apps
 *   bond sense clear [today|all]              Delete capture data
 *   bond sense stats                          Storage usage stats
 *   bond sense config                         Show settings
 *   bond sense config <key> <value>           Update setting
 */

import { call, connect } from './connect'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? ''

  const ws = await connect()

  try {
    switch (cmd) {
      case '':
      case 'status': {
        const status = await call(ws, 'sense.status') as {
          enabled: boolean; state: string; captureCount: number;
          sessionCount: number; storageBytes: number; oldestCapture: string | null
        }
        const stateColor = status.state === 'recording' ? GREEN :
                           status.state === 'paused' ? YELLOW :
                           status.state === 'disabled' ? RED : DIM
        console.log(`${BOLD}Sense${RESET}  ${stateColor}${status.state}${RESET}`)
        console.log(`  Captures:  ${status.captureCount}`)
        console.log(`  Sessions:  ${status.sessionCount}`)
        console.log(`  Storage:   ${formatBytes(status.storageBytes)}`)
        if (status.oldestCapture) {
          console.log(`  Since:     ${formatDate(status.oldestCapture)}`)
        }
        break
      }

      case 'on': {
        await call(ws, 'sense.enable')
        console.log(`${GREEN}Sense enabled${RESET}`)
        break
      }

      case 'off': {
        await call(ws, 'sense.disable')
        console.log(`${YELLOW}Sense disabled${RESET}`)
        break
      }

      case 'pause': {
        const minutes = parseInt(args[1], 10) || 10
        const result = await call(ws, 'sense.pause', { minutes }) as { ok: boolean; resumeAt: string }
        console.log(`${YELLOW}Paused${RESET} until ${formatTime(result.resumeAt)}`)
        break
      }

      case 'resume': {
        await call(ws, 'sense.resume')
        console.log(`${GREEN}Resumed${RESET}`)
        break
      }

      case 'now': {
        const result = await call(ws, 'sense.now') as {
          capture: { app_name: string; window_title: string; text_content: string; captured_at: string } | null
          state: string
        }
        if (!result.capture) {
          console.log(`${DIM}No recent captures${RESET}`)
          break
        }
        const c = result.capture
        console.log(`${BOLD}${c.app_name}${RESET}  ${DIM}${c.window_title}${RESET}`)
        console.log(`${DIM}Captured at ${formatTime(c.captured_at)}${RESET}`)
        if (c.text_content) {
          console.log()
          // Show first 10 lines
          const lines = c.text_content.split('\n').slice(0, 10)
          for (const line of lines) console.log(`  ${line}`)
          const total = c.text_content.split('\n').length
          if (total > 10) console.log(`  ${DIM}... ${total - 10} more lines${RESET}`)
        }
        break
      }

      case 'today':
      case 'yesterday':
      case 'week': {
        const range = cmd === 'week' ? 'week' : 'today'
        if (cmd === 'yesterday') {
          const yesterday = new Date()
          yesterday.setDate(yesterday.getDate() - 1)
          const from = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0, 0).toISOString()
          const to = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999).toISOString()
          const timeline = await call(ws, 'sense.timeline', { from, to, limit: 100 }) as
            { app_name: string; captured_at: string }[]
          printTimeline(timeline, 'Yesterday')
        } else {
          const result = await call(ws, 'sense.today') as {
            sessions: { id: string; started_at: string; ended_at: string; capture_count: number }[]
            apps: { app_name: string; capture_count: number; first_seen: string; last_seen: string }[]
          }
          console.log(`${BOLD}${cmd === 'week' ? 'This Week' : 'Today'}${RESET}`)
          if (result.apps.length === 0) {
            console.log(`  ${DIM}No activity${RESET}`)
          } else {
            for (const app of result.apps) {
              console.log(`  ${CYAN}${app.app_name}${RESET}  ${app.capture_count} captures  ${DIM}${formatTime(app.first_seen)} – ${formatTime(app.last_seen)}${RESET}`)
            }
          }
        }
        break
      }

      case 'search': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error('Usage: bond sense search <query>'); process.exit(1) }
        const results = await call(ws, 'sense.search', { query, limit: 10 }) as
          { app_name: string; window_title: string; captured_at: string; text_content: string }[]
        if (results.length === 0) {
          console.log(`${DIM}No results for "${query}"${RESET}`)
        } else {
          for (const r of results) {
            console.log(`${BOLD}${r.app_name}${RESET}  ${DIM}${r.window_title}${RESET}  ${DIM}${formatTime(r.captured_at)}${RESET}`)
            if (r.text_content) {
              const snippet = r.text_content.split('\n').slice(0, 2).join(' ').slice(0, 120)
              console.log(`  ${snippet}`)
            }
            console.log()
          }
        }
        break
      }

      case 'apps': {
        const range = args[1] ?? 'today'
        const apps = await call(ws, 'sense.apps', { range }) as
          { app_name: string; app_bundle_id: string; capture_count: number; first_seen: string; last_seen: string }[]
        if (apps.length === 0) {
          console.log(`${DIM}No app data${RESET}`)
        } else {
          for (const app of apps) {
            console.log(`  ${CYAN}${app.app_name}${RESET}  ${app.capture_count} captures  ${DIM}${app.app_bundle_id}${RESET}`)
          }
        }
        break
      }

      case 'timeline': {
        const limit = 20
        let from: string | undefined
        let to: string | undefined
        if (args[1]) {
          // Simple range parsing: "9am-12pm" or ISO dates
          from = args[1]
          to = args[2]
        }
        const results = await call(ws, 'sense.timeline', { from, to, limit }) as
          { app_name: string; window_title: string; captured_at: string; capture_trigger: string }[]
        printTimeline(results, 'Timeline')
        break
      }

      case 'exclude': {
        const bundleId = args[1]
        if (!bundleId) { console.error('Usage: bond sense exclude <bundleId>'); process.exit(1) }
        const settings = await call(ws, 'sense.settings') as { blacklistedApps: string[] }
        if (!settings.blacklistedApps.includes(bundleId)) {
          settings.blacklistedApps.push(bundleId)
          await call(ws, 'sense.updateSettings', { updates: { blacklistedApps: settings.blacklistedApps } })
        }
        console.log(`${GREEN}Excluded${RESET} ${bundleId}`)
        break
      }

      case 'include': {
        const bundleId = args[1]
        if (!bundleId) { console.error('Usage: bond sense include <bundleId>'); process.exit(1) }
        const settings = await call(ws, 'sense.settings') as { blacklistedApps: string[] }
        const idx = settings.blacklistedApps.indexOf(bundleId)
        if (idx !== -1) {
          settings.blacklistedApps.splice(idx, 1)
          await call(ws, 'sense.updateSettings', { updates: { blacklistedApps: settings.blacklistedApps } })
        }
        console.log(`${GREEN}Included${RESET} ${bundleId}`)
        break
      }

      case 'excluded': {
        const settings = await call(ws, 'sense.settings') as { blacklistedApps: string[] }
        if (settings.blacklistedApps.length === 0) {
          console.log(`${DIM}No custom exclusions (defaults still apply)${RESET}`)
        } else {
          for (const app of settings.blacklistedApps) console.log(`  ${app}`)
        }
        break
      }

      case 'clear': {
        const what = args[1] ?? 'today'
        let range: { from?: string; to?: string } | undefined
        if (what === 'today') {
          const now = new Date()
          range = { from: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString() }
        } else if (what !== 'all') {
          range = { from: what }
        }
        const result = await call(ws, 'sense.clear', { range }) as { deletedCount: number }
        console.log(`${YELLOW}Cleared${RESET} ${result.deletedCount} captures`)
        break
      }

      case 'stats': {
        const stats = await call(ws, 'sense.stats') as {
          storageBytes: number; captureCount: number; sessionCount: number; oldestCapture: string | null
        }
        console.log(`${BOLD}Sense Stats${RESET}`)
        console.log(`  Storage:    ${formatBytes(stats.storageBytes)}`)
        console.log(`  Captures:   ${stats.captureCount}`)
        console.log(`  Sessions:   ${stats.sessionCount}`)
        if (stats.oldestCapture) {
          console.log(`  Since:      ${formatDate(stats.oldestCapture)}`)
        }
        break
      }

      case 'config': {
        if (args.length === 1) {
          const settings = await call(ws, 'sense.settings') as Record<string, unknown>
          for (const [key, value] of Object.entries(settings)) {
            console.log(`  ${CYAN}${key}${RESET}: ${JSON.stringify(value)}`)
          }
        } else {
          const key = args[1]
          const rawValue = args[2]
          if (!rawValue) { console.error('Usage: bond sense config <key> <value>'); process.exit(1) }
          let value: unknown = rawValue
          if (rawValue === 'true') value = true
          else if (rawValue === 'false') value = false
          else if (!isNaN(Number(rawValue))) value = Number(rawValue)
          await call(ws, 'sense.updateSettings', { updates: { [key]: value } })
          console.log(`${GREEN}Set${RESET} ${key} = ${JSON.stringify(value)}`)
        }
        break
      }

      case 'memory': {
        const result = await call(ws, 'sense.memory', { limit: 5 }) as {
          debriefs: { session_title?: string; sessionTitle?: string; summary: string; created_at?: string; createdAt?: string; topics: string[] | string; decisions: string[] | string; open_threads?: string[] | string; openThreads?: string[] | string }[]
          facts: { id: string; fact: string; project_id?: string; projectId?: string }[]
        }
        if (result.facts.length > 0) {
          console.log(`${BOLD}Pinned Facts${RESET}`)
          for (const f of result.facts) {
            const proj = f.project_id || f.projectId
            const tag = proj ? ` ${DIM}[project]${RESET}` : ''
            console.log(`  - ${f.fact}${tag}`)
          }
          console.log()
        }
        if (result.debriefs.length > 0) {
          console.log(`${BOLD}Recent Debriefs${RESET}`)
          for (const d of result.debriefs) {
            const title = d.sessionTitle ?? d.session_title ?? 'Untitled'
            const date = d.createdAt ?? d.created_at ?? ''
            console.log(`  ${CYAN}${title}${RESET}  ${DIM}${date ? formatDate(date) : ''}${RESET}`)
            console.log(`    ${d.summary}`)
          }
        }
        if (result.debriefs.length === 0 && result.facts.length === 0) {
          console.log(`${DIM}No memory data yet. Archive some sessions to generate debriefs.${RESET}`)
        }
        break
      }

      case 'threads': {
        const threads = await call(ws, 'sense.threads', { limit: 10 }) as string[]
        if (threads.length === 0) {
          console.log(`${DIM}No open threads${RESET}`)
        } else {
          console.log(`${BOLD}Open Threads${RESET}`)
          for (const t of threads) {
            console.log(`  - ${t}`)
          }
        }
        break
      }

      case 'decisions': {
        const decisions = await call(ws, 'sense.decisions', { limit: 10 }) as
          { decision: string; sessionTitle: string; createdAt: string }[]
        if (decisions.length === 0) {
          console.log(`${DIM}No recent decisions${RESET}`)
        } else {
          console.log(`${BOLD}Recent Decisions${RESET}`)
          for (const d of decisions) {
            console.log(`  - ${d.decision}  ${DIM}(${d.sessionTitle})${RESET}`)
          }
        }
        break
      }

      case 'debrief': {
        const sessionId = args[1]
        if (!sessionId) { console.error('Usage: bond sense debrief <session-id>'); process.exit(1) }
        const debrief = await call(ws, 'sense.debrief', { sessionId }) as {
          sessionTitle: string; session_title?: string; summary: string
          topics: string[] | string; decisions: string[] | string
          open_threads?: string[] | string; openThreads?: string[] | string
          key_facts?: string[] | string; keyFacts?: string[] | string
          messageCount?: number; message_count?: number
          durationSeconds?: number; duration_seconds?: number
          createdAt?: string; created_at?: string
        } | null
        if (!debrief) {
          console.log(`${DIM}No debrief found for session ${sessionId}${RESET}`)
        } else {
          const title = debrief.sessionTitle ?? debrief.session_title ?? 'Untitled'
          console.log(`${BOLD}${title}${RESET}`)
          console.log(`  ${debrief.summary}`)
          const topics = parseArr(debrief.topics)
          if (topics.length > 0) console.log(`\n  ${DIM}Topics:${RESET} ${topics.join(', ')}`)
          const decisions = parseArr(debrief.decisions)
          if (decisions.length > 0) {
            console.log(`\n  ${BOLD}Decisions:${RESET}`)
            for (const d of decisions) console.log(`    - ${d}`)
          }
          const threads = parseArr(debrief.openThreads ?? debrief.open_threads)
          if (threads.length > 0) {
            console.log(`\n  ${BOLD}Open Threads:${RESET}`)
            for (const t of threads) console.log(`    - ${t}`)
          }
          const facts = parseArr(debrief.keyFacts ?? debrief.key_facts)
          if (facts.length > 0) {
            console.log(`\n  ${BOLD}Key Facts:${RESET}`)
            for (const f of facts) console.log(`    - ${f}`)
          }
        }
        break
      }

      case 'remember': {
        const fact = args.slice(1).join(' ')
        if (!fact) { console.error('Usage: bond sense remember <fact>'); process.exit(1) }
        const projectArg = args.indexOf('--project')
        let projectId: string | undefined
        let factText = fact
        if (projectArg !== -1) {
          projectId = args[projectArg + 1]
          factText = args.slice(1, projectArg).join(' ')
        }
        await call(ws, 'sense.remember', { fact: factText, projectId })
        console.log(`${GREEN}Remembered${RESET}: ${factText}`)
        break
      }

      case 'facts': {
        const facts = await call(ws, 'sense.facts') as
          { id: string; fact: string; source: string; project_id?: string; projectId?: string; created_at?: string; createdAt?: string }[]
        if (facts.length === 0) {
          console.log(`${DIM}No pinned facts${RESET}`)
        } else {
          console.log(`${BOLD}Active Facts${RESET}`)
          for (let i = 0; i < facts.length; i++) {
            const f = facts[i]
            const proj = f.project_id || f.projectId
            const src = f.source === 'debrief' ? ` ${DIM}[from debrief]${RESET}` : ''
            const tag = proj ? ` ${DIM}[project]${RESET}` : ''
            console.log(`  ${DIM}${i + 1}.${RESET} ${f.fact}${src}${tag}`)
          }
        }
        break
      }

      case 'forget': {
        const target = args[1]
        if (!target) { console.error('Usage: bond sense forget <id|number>'); process.exit(1) }
        // Support numeric index (1-based) or UUID
        let factId = target
        if (/^\d+$/.test(target)) {
          const facts = await call(ws, 'sense.facts') as { id: string }[]
          const idx = parseInt(target, 10) - 1
          if (idx < 0 || idx >= facts.length) {
            console.error(`Invalid fact number: ${target} (${facts.length} facts exist)`)
            process.exit(1)
          }
          factId = facts[idx].id
        }
        const result = await call(ws, 'sense.forget', { id: factId }) as { ok: boolean }
        if (result.ok) {
          console.log(`${YELLOW}Forgotten${RESET}`)
        } else {
          console.log(`${RED}Fact not found${RESET}`)
        }
        break
      }

      case 'backfill': {
        let limit = 50
        const limitIdx = args.indexOf('--limit')
        if (limitIdx !== -1 && args[limitIdx + 1]) {
          limit = parseInt(args[limitIdx + 1], 10) || 50
        }
        console.log(`${DIM}Starting backfill for up to ${limit} sessions...${RESET}`)
        const result = await call(ws, 'sense.backfill', { limit }) as { ok: boolean; message: string }
        console.log(`${GREEN}${result.message}${RESET}`)
        break
      }

      default:
        console.error(`Unknown command: ${cmd}`)
        console.error('Usage: bond sense [status|on|off|pause|resume|now|today|search|apps|timeline|memory|threads|decisions|debrief|remember|facts|forget|backfill|exclude|include|excluded|clear|stats|config]')
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

function parseArr(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter(i => typeof i === 'string')
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return Array.isArray(parsed) ? parsed.filter(i => typeof i === 'string') : []
    } catch { return [] }
  }
  return []
}

function printTimeline(
  captures: { app_name: string; window_title?: string; captured_at: string; capture_trigger?: string }[],
  title: string
): void {
  console.log(`${BOLD}${title}${RESET}`)
  if (captures.length === 0) {
    console.log(`  ${DIM}No activity${RESET}`)
    return
  }
  for (const c of captures) {
    const trigger = c.capture_trigger ? `${DIM}[${c.capture_trigger}]${RESET}` : ''
    console.log(`  ${DIM}${formatTime(c.captured_at)}${RESET}  ${CYAN}${c.app_name}${RESET}  ${c.window_title ?? ''} ${trigger}`)
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
