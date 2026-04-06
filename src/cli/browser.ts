#!/usr/bin/env node

/**
 * bond browser — CLI for controlling Bond's in-app browser.
 *
 * Usage:
 *   bond browser open <url>              Open URL in new tab
 *   bond browser tabs                     List open tabs
 *   bond browser navigate <tab> <url>    Navigate existing tab
 *   bond browser close <tab>              Close tab
 *   bond browser read [tab]               Get page text (active tab if omitted)
 *   bond browser screenshot [tab]         Capture page as PNG
 *   bond browser exec [tab] "<js>"        Run JavaScript in page
 *   bond browser console [tab]            Get console output
 *   bond browser dom [tab] [selector]     Read page HTML or query elements
 *   bond browser network [tab]            Recent network requests
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

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${SOCK}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', (err) => reject(err))
  })
}

const R = '\x1b[31m'
const G = '\x1b[32m'
const Y = '\x1b[33m'
const D = '\x1b[90m'
const N = '\x1b[0m'

async function main() {
  const args = process.argv.slice(2)
  const sub = args[0]

  if (!sub || sub === 'help' || sub === '-h') {
    console.log(`${G}bond browser${N} — in-app browser control

  ${G}open${N} <url> [--hidden]    Open URL in new tab (--hidden for background)
  ${G}tabs${N}                     List open tabs
  ${G}navigate${N} <tab> <url>    Navigate existing tab
  ${G}close${N} <tab>              Close tab
  ${G}read${N} [tab]               Get page text
  ${G}screenshot${N} [tab]         Capture page as PNG
  ${G}exec${N} [tab] "<js>"        Run JavaScript in page
  ${G}console${N} [tab]            Get console output
  ${G}dom${N} [tab] [selector]     Read page HTML / query elements
  ${G}network${N} [tab]            Recent network requests`)
    return
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error(`${R}Cannot connect to daemon.${N} Is Bond running?`)
    process.exit(1)
  }

  try {
    switch (sub) {
      case 'open': {
        const hidden = args.includes('--hidden')
        const url = args.slice(1).find(a => a !== '--hidden')
        if (!url) { console.error(`${R}Usage:${N} bond browser open <url> [--hidden]`); break }
        const result = await call(ws, 'browser.open', { url, hidden }) as any
        if (result?.error) { console.error(`${R}Error:${N} ${result.error}`); break }
        const label = hidden ? `${G}Opened${N} hidden tab` : `${G}Opened${N} tab`
        console.log(`${label} ${D}${result.tabId}${N}`)
        if (result.title) console.log(`  title: ${result.title}`)
        if (result.url) console.log(`  url: ${result.url}`)
        break
      }

      case 'tabs': {
        const tabs = await call(ws, 'browser.tabs') as any[]
        if (!tabs || tabs.length === 0) {
          console.log(`${D}No tabs open${N}`)
          break
        }
        for (const tab of tabs) {
          const marker = tab.active ? `${G}*${N}` : ' '
          const flags = [
            tab.loading ? `${Y}loading${N}` : '',
            tab.hidden ? `${D}[hidden]${N}` : '',
          ].filter(Boolean).join(' ')
          console.log(`${marker} ${D}${tab.id.slice(0, 8)}${N}  ${tab.title || '(untitled)'}  ${D}${tab.url}${N}  ${flags}`)
        }
        break
      }

      case 'navigate': {
        const tabId = args[1]
        const url = args[2]
        if (!tabId || !url) { console.error(`${R}Usage:${N} bond browser navigate <tab> <url>`); break }
        const result = await call(ws, 'browser.navigate', { tabId, url }) as any
        if (result?.error) { console.error(`${R}Error:${N} ${result.error}`); break }
        console.log(`${G}Navigated${N}`)
        if (result.title) console.log(`  title: ${result.title}`)
        break
      }

      case 'close': {
        const tabId = args[1]
        if (!tabId) { console.error(`${R}Usage:${N} bond browser close <tab>`); break }
        await call(ws, 'browser.close', { tabId })
        console.log(`${G}Closed${N} tab ${D}${tabId}${N}`)
        break
      }

      case 'read': {
        const tabId = args[1] || undefined
        const result = await call(ws, 'browser.read', { tabId })
        if (typeof result === 'string') {
          console.log(result)
        } else if ((result as any)?.error) {
          console.error(`${R}Error:${N} ${(result as any).error}`)
        }
        break
      }

      case 'screenshot': case 'ss': {
        const tabId = args[1] || undefined
        const result = await call(ws, 'browser.screenshot', { tabId }) as any
        if (result?.error) { console.error(`${R}Error:${N} ${result.error}`); break }
        console.log(typeof result === 'string' ? result : result?.path ?? JSON.stringify(result))
        break
      }

      case 'exec': {
        // bond browser exec [tabId] "js code"
        // If only one arg after 'exec', treat as JS on active tab
        let tabId: string | undefined
        let js: string
        if (args.length >= 3) {
          tabId = args[1]
          js = args.slice(2).join(' ')
        } else {
          js = args[1] || ''
        }
        if (!js) { console.error(`${R}Usage:${N} bond browser exec [tab] "<js>"`); break }
        const result = await call(ws, 'browser.exec', { tabId, js }) as any
        if (result?.error) { console.error(`${R}Error:${N} ${result.error}`); break }
        console.log(result?.value ?? JSON.stringify(result))
        break
      }

      case 'console': {
        const tabId = args[1] || undefined
        const entries = await call(ws, 'browser.console', { tabId }) as any[]
        if (!entries || entries.length === 0) {
          console.log(`${D}No console output${N}`)
          break
        }
        for (const e of entries) {
          const color = e.level === 'error' ? R : e.level === 'warn' ? Y : ''
          const reset = color ? N : ''
          const source = e.source ? ` ${D}${e.source}${N}` : ''
          console.log(`${color}[${e.level}]${reset} ${e.text}${source}`)
        }
        break
      }

      case 'dom': {
        const tabId = args[1] || undefined
        const selector = args[2] || undefined
        const result = await call(ws, 'browser.dom', { tabId, selector })
        if (typeof result === 'string') {
          console.log(result)
        } else if ((result as any)?.error) {
          console.error(`${R}Error:${N} ${(result as any).error}`)
        } else {
          console.log(JSON.stringify(result, null, 2))
        }
        break
      }

      case 'network': {
        const tabId = args[1] || undefined
        const entries = await call(ws, 'browser.network', { tabId }) as any[]
        if (!entries || entries.length === 0) {
          console.log(`${D}No network requests${N}`)
          break
        }
        for (const e of entries) {
          const statusColor = e.status >= 400 ? R : e.status >= 300 ? Y : G
          console.log(`${e.method.padEnd(6)} ${statusColor}${e.status ?? '...'}${N}  ${D}${e.timing}ms${N}  ${e.url}`)
        }
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(`${R}Error:${N} ${err.message}`)
  process.exit(1)
})
