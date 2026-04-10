#!/usr/bin/env node

/**
 * Bond daemon — standalone entry point.
 *
 * Starts a WebSocket server on a Unix domain socket at ~/.bond/bond.sock.
 * Manages agent queries, sessions, and settings independently of any UI.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { setDataDir, ensureSkillsDir } from './paths'
import { startServer } from './server'

const runtimeDir = join(homedir(), '.bond')
const socketPath = join(runtimeDir, 'bond.sock')
const tokenPath = join(runtimeDir, 'bond.token')
const pidPath = join(runtimeDir, 'daemon.pid')

// Data lives in macOS Application Support (same location Electron uses)
const dataDir = join(homedir(), 'Library', 'Application Support', 'bond')

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function writePid(): void {
  writeFileSync(pidPath, String(process.pid), 'utf-8')
}

function removePid(): void {
  try { unlinkSync(pidPath) } catch { /* ignore */ }
}

function generateAuthToken(): string {
  const token = randomBytes(32).toString('hex')
  writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  return token
}

function removeToken(): void {
  try { unlinkSync(tokenPath) } catch { /* ignore */ }
}

function main(): void {
  ensureDir(runtimeDir)
  ensureDir(dataDir)
  setDataDir(dataDir)
  ensureSkillsDir()

  const authToken = generateAuthToken()
  const server = startServer(socketPath, authToken)
  writePid()

  console.log(`[bond-daemon] pid=${process.pid} socket=${socketPath}`)

  function shutdown(): void {
    console.log('[bond-daemon] shutting down…')
    server.close().then(() => {
      removePid()
      removeToken()
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main()
