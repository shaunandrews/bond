#!/usr/bin/env node

/**
 * Bond daemon — standalone entry point.
 *
 * Starts a WebSocket server on a Unix domain socket at ~/.bond/bond.sock.
 * Manages agent queries, sessions, and settings independently of any UI.
 */

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setDataDir, ensureSkillsDir } from './paths'
import { startServer, attachConnection, registerBroadcastServer } from './server'
import { startRemoteServer, type RemoteServer } from './remote'
import { getRemotePort, getOrCreateRemoteToken } from './settings'

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
  // Bond-owned defaults for the bundled pi-codex-image-gen extension: Bond
  // persists generated images itself (no duplicate files under Pi's agent
  // dir) and ships no install telemetry. An explicit user env still wins.
  process.env.PI_CODEX_IMAGE_SAVE_MODE ??= 'none'
  process.env.PI_TELEMETRY ??= '0'

  ensureDir(runtimeDir)
  ensureDir(dataDir)
  setDataDir(dataDir)
  ensureSkillsDir()

  const authToken = generateAuthToken()
  const server = startServer(socketPath, authToken)
  writePid()

  // Remote access: serve the browser bundle + WebSocket RPC on the LAN,
  // gated by the persistent pairing token. Failure (e.g. port in use) is
  // logged inside startRemoteServer and never takes the daemon down.
  let remote: RemoteServer | null = null
  try {
    const remoteToken = getOrCreateRemoteToken()
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
    remote = startRemoteServer({
      port: getRemotePort(),
      token: remoteToken,
      webRoot,
      attach: (ws) => attachConnection(ws, remoteToken),
    })
    registerBroadcastServer(remote.wss)
  } catch (err) {
    console.error(`[bond-daemon] remote server failed to start: ${err instanceof Error ? err.message : String(err)}`)
  }

  console.log(`[bond-daemon] pid=${process.pid} socket=${socketPath}`)

  function shutdown(): void {
    console.log('[bond-daemon] shutting down…')
    // If any close hangs (a lingering connection, a wedged handle), exit
    // anyway — a zombie daemon keeps holding the remote port and the next
    // daemon can't bind it.
    setTimeout(() => {
      console.error('[bond-daemon] shutdown timed out — exiting')
      removePid()
      removeToken()
      process.exit(1)
    }, 5000).unref()
    const closeRemote = remote ? remote.close() : Promise.resolve()
    closeRemote.then(() => server.close()).then(() => {
      removePid()
      removeToken()
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main()
