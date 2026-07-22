#!/usr/bin/env node

/**
 * bond memory — is Bond's memory actually writing?
 *
 * Usage:
 *   bond memory            Health report (same as `bond memory status`)
 *   bond memory status     Health report
 *   bond memory --json     Raw MemoryHealth as JSON
 */

import { call, connect, type WebSocket } from './connect'
import type { MemoryHealth } from '../shared/memory'
import { formatMemoryStatus, isDegraded, parseMemoryArgs } from './memory-helpers'

const R = '\x1b[0;31m'
const N = '\x1b[0m'

async function main() {
  const args = parseMemoryArgs(process.argv.slice(2))

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error('Cannot connect to Bond daemon. Is it running?')
    process.exit(1)
  }

  try {
    const health = await call(ws, 'memory.health') as MemoryHealth
    if (args.json) {
      console.log(JSON.stringify(health, null, 2))
      return
    }
    const report = formatMemoryStatus(health)
    console.log(isDegraded(health) ? `${R}${report}${N}` : report)
    if (isDegraded(health)) process.exitCode = 1
  } finally {
    ws.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
