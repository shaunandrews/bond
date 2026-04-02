#!/usr/bin/env node

/**
 * bond screenshot — Capture the Bond window and save to media library.
 *
 * Triggers Electron's capturePage via a file trigger, then imports
 * the resulting PNG into Bond's media system.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const SOCK = join(homedir(), '.bond', 'bond.sock')
const TRIGGER = '/tmp/bond-capture'
const TMP_OUTPUT = '/tmp/bond-screenshot.png'

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const D = '\x1b[0;90m'
const N = '\x1b[0m'

async function main() {
  // 1. Trigger the screenshot
  writeFileSync(TRIGGER, '')

  // 2. Wait for Electron to capture and write the file
  let waited = 0
  while (existsSync(TRIGGER) && waited < 3000) {
    await sleep(100)
    waited += 100
  }

  if (!existsSync(TMP_OUTPUT)) {
    console.error(`${R}Screenshot failed${N} — Bond didn't respond`)
    try { unlinkSync(TRIGGER) } catch {}
    process.exit(1)
  }

  // 3. Read the PNG and base64 encode it
  const buf = readFileSync(TMP_OUTPUT)
  const data = buf.toString('base64')

  // 4. Connect to daemon and import into media
  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    // Still save locally even if daemon is down
    console.log(`${G}Screenshot saved${N}  ${TMP_OUTPUT} ${D}(not imported — daemon unavailable)${N}`)
    process.exit(0)
  }

  try {
    const record = await call(ws, 'image.import', { data, mediaType: 'image/png' }) as { id: string; filename: string; sizeBytes: number }
    // Clean up tmp file since it's now in media
    try { unlinkSync(TMP_OUTPUT) } catch {}
    console.log(`${G}Screenshot saved${N}  ${D}${record.filename} (${(record.sizeBytes / 1024).toFixed(1)} KB)${N}`)
  } catch (err) {
    console.error(`${R}Failed to import:${N} ${err}`)
    console.log(`${D}Screenshot still at ${TMP_OUTPUT}${N}`)
  } finally {
    ws.close()
  }
}

main()
