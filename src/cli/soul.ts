#!/usr/bin/env node

/**
 * bond soul — CLI for reading and writing Bond's personality/soul.
 *
 * Usage:
 *   bond soul                         Show the current soul
 *   bond soul show                    Same as above
 *   bond soul set "text"              Set the soul to the given text
 *   bond soul set --body "text"       Set with explicit flag
 *   echo "..." | bond soul set        Set from stdin
 *   bond soul clear                   Clear the soul
 *   bond soul append "text"           Append a line to the existing soul
 */

import { call, connect, WebSocket } from './connect'

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { buf += chunk })
    process.stdin.on('end', () => resolve(buf.trim()))
  })
}

const D = '\x1b[0;90m'
const N = '\x1b[0m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'

async function main() {
  const args = process.argv.slice(2)
  const sub = args[0] || 'show'

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error('Cannot connect to Bond daemon. Is it running?')
    process.exit(1)
  }

  try {
    switch (sub) {
      case 'show':
      case 'get': {
        const soul = await call(ws, 'settings.getSoul') as string
        if (!soul) {
          console.log(`${D}(empty — no personality set)${N}`)
        } else {
          console.log(soul)
        }
        break
      }

      case 'set': {
        let text = ''
        // Check for --body flag
        const bodyIdx = args.indexOf('--body')
        if (bodyIdx !== -1 && args[bodyIdx + 1]) {
          text = args.slice(bodyIdx + 1).join(' ')
        } else if (args.length > 1 && args[1] !== '--body') {
          text = args.slice(1).join(' ')
        } else {
          text = await readStdin()
        }

        if (!text) {
          console.error('No text provided. Usage: bond soul set "your personality text"')
          process.exit(1)
        }

        await call(ws, 'settings.saveSoul', { content: text })
        console.log(`${G}Soul updated${N}`)
        console.log(`${D}${text.length} chars — takes effect on next message${N}`)
        break
      }

      case 'append': {
        let text = ''
        if (args.length > 1) {
          text = args.slice(1).join(' ')
        } else {
          text = await readStdin()
        }

        if (!text) {
          console.error('No text provided. Usage: bond soul append "additional personality text"')
          process.exit(1)
        }

        const current = await call(ws, 'settings.getSoul') as string
        const updated = current ? `${current}\n${text}` : text
        await call(ws, 'settings.saveSoul', { content: updated })
        console.log(`${G}Soul appended${N}`)
        console.log(`${D}${updated.length} chars total — takes effect on next message${N}`)
        break
      }

      case 'clear': {
        await call(ws, 'settings.saveSoul', { content: '' })
        console.log(`${Y}Soul cleared${N}`)
        break
      }

      default:
        // If no subcommand recognized, treat as "show"
        const soul = await call(ws, 'settings.getSoul') as string
        if (!soul) {
          console.log(`${D}(empty — no personality set)${N}`)
        } else {
          console.log(soul)
        }
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
