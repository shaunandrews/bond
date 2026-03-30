#!/usr/bin/env node

/**
 * Bond daemon — standalone entry point.
 *
 * Starts a WebSocket server on a Unix domain socket at ~/.bond/bond.sock.
 * Manages agent queries, sessions, and settings independently of any UI.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { setDataDir, ensureSkillsDir } from './paths'
import { startServer } from './server'

const runtimeDir = join(homedir(), '.bond')
const socketPath = join(runtimeDir, 'bond.sock')
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

function main(): void {
  ensureDir(runtimeDir)
  ensureDir(dataDir)
  setDataDir(dataDir)
  ensureSkillsDir()

  const server = startServer(socketPath)
  writePid()

  console.log(`[bond-daemon] pid=${process.pid} socket=${socketPath}`)

  function shutdown(): void {
    console.log('[bond-daemon] shutting down…')
    server.close().then(() => {
      removePid()
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main()
