/**
 * Shared daemon connection helper for CLI commands.
 * Reads the auth token from ~/.bond/bond.token and authenticates after connecting.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import WebSocket from 'ws'

const BOND_DIR = join(homedir(), '.bond')
export const SOCK = join(BOND_DIR, 'bond.sock')

export { WebSocket }
const TOKEN_PATH = join(BOND_DIR, 'bond.token')

let reqId = 1

export function call(ws: WebSocket, method: string, params?: unknown): Promise<unknown> {
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

export function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${SOCK}`)
    ws.on('open', async () => {
      try {
        // Read auth token and authenticate
        if (existsSync(TOKEN_PATH)) {
          const token = readFileSync(TOKEN_PATH, 'utf-8').trim()
          if (token) {
            await call(ws, 'bond.auth', { token })
          }
        }
        resolve(ws)
      } catch (err) {
        ws.close()
        reject(err)
      }
    })
    ws.on('error', (err) => reject(err))
  })
}
