#!/usr/bin/env node

/**
 * bond sense — CLI for Sense ambient screen awareness.
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
 *   bond sense search <query>                 Full-text search
 *   bond sense apps [today|week]              App usage breakdown
 *   bond sense timeline [range]               Chronological activity
 *   bond sense exclude <bundleId>             Add app to blacklist
 *   bond sense include <bundleId>             Remove app from blacklist
 *   bond sense excluded                       List blacklisted apps
 *   bond sense clear [today|all]              Delete capture data
 *   bond sense stats                          Storage usage stats
 *   bond sense config                         Show settings
 *   bond sense config <key> <value>           Update setting
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const SOCK = join(homedir(), '.bond', 'bond.sock')

let reqId = 1

function call(ws: WebSocket, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = reqId++
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    const onMessage = (data: WebSocket.Data) => {
      const parsed = JSON.parse(data.toString())
      if (parsed.id === id) {
        ws.off('message', onMessage)
        if (parsed.error) reject(new Error(parsed.error.message))
        else resolve(parsed.result)
      }
    }

    ws.on('message', onMessage)
    ws.send(msg)
  })
}

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

  const ws = new WebSocket(`ws+unix://${SOCK}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', () => reject(new Error('Cannot connect to Bond daemon. Is it running?')))
  })

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
          const from = yesterday.toISOString().split('T')[0] + 'T00:00:00Z'
          const to = yesterday.toISOString().split('T')[0] + 'T23:59:59Z'
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
          const today = new Date().toISOString().split('T')[0]
          range = { from: today + 'T00:00:00Z' }
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

      default:
        console.error(`Unknown command: ${cmd}`)
        console.error('Usage: bond sense [status|on|off|pause|resume|now|today|search|apps|timeline|exclude|include|excluded|clear|stats|config]')
        process.exit(1)
    }
  } finally {
    ws.close()
  }
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
