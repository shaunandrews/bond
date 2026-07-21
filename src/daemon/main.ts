#!/usr/bin/env node

/**
 * Bond daemon — standalone entry point.
 *
 * Starts a WebSocket server on a Unix domain socket at ~/.bond/bond.sock.
 * Manages agent queries, sessions, and settings independently of any UI.
 */

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setDataDir, ensureSkillsDir } from './paths'
import { claimSocket, daemonHealth, socketIdentity, startSocketWatchdog } from './lifecycle'
import { installWireToolLogging, installWireWebSocketLogging } from './wire-debug'
import { startServer, attachConnection, registerBroadcastServer, startDeskIfRunning, stopDesk } from './server'
import { startRemoteServer, type RemoteServer } from './remote'
import { exchangePairingCode, isValidDeviceToken } from './pairing'
import { getRemotePort, getOrCreateRemoteToken } from './settings'
import { shutdownMcp } from './mcp/manager'

const runtimeDir = join(homedir(), '.bond')
const socketPath = join(runtimeDir, 'bond.sock')
const tokenPath = join(runtimeDir, 'bond.token')
const pidPath = join(runtimeDir, 'daemon.pid')
const startLockPath = join(runtimeDir, 'daemon.starting')

// Data lives in macOS Application Support (same location Electron uses)
const dataDir = join(homedir(), 'Library', 'Application Support', 'bond')

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function writePid(): void {
  writeFileSync(pidPath, String(process.pid), 'utf-8')
}

/** Remove the pid file only if it still names this process — a successor may own it by now. */
function removePid(): void {
  try {
    if (readFileSync(pidPath, 'utf-8').trim() === String(process.pid)) unlinkSync(pidPath)
  } catch { /* ignore */ }
}

function generateAuthToken(): string {
  const token = randomBytes(32).toString('hex')
  writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  return token
}

/** Remove the token file only if it still holds this instance's token — a successor may own it by now. */
function removeToken(token: string): void {
  try {
    if (readFileSync(tokenPath, 'utf-8').trim() === token) unlinkSync(tokenPath)
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  // Bond-owned defaults for the bundled pi-codex-image-gen extension: Bond
  // persists generated images itself (no duplicate files under Pi's agent
  // dir) and ships no install telemetry. An explicit user env still wins.
  process.env.PI_CODEX_IMAGE_SAVE_MODE ??= 'none'
  process.env.PI_TELEMETRY ??= '0'

  ensureDir(runtimeDir)
  // Singleton guard: launchd (KeepAlive), the Electron app, and the CLI can
  // all try to start a daemon. Takeover is serialized through a start lock
  // and gated on a live probe of the socket itself — never a pid file. If a
  // live daemon answers, bow out with exit 0, which launchd's
  // KeepAlive/SuccessfulExit=false reads as "stay quiet" rather than
  // respawning us in a loop.
  const claim = await claimSocket(socketPath, startLockPath)
  if (!claim.claimed) {
    console.log('[bond-daemon] another daemon is serving the socket — exiting')
    process.exit(0)
  }
  writePid() // informational — lifecycle truth lives at GET /health on the socket
  installWireToolLogging()
  installWireWebSocketLogging()
  ensureDir(dataDir)
  setDataDir(dataDir)
  ensureSkillsDir()

  const startedAt = new Date()
  const bundlePath = process.argv[1] ?? null
  const authToken = generateAuthToken()
  const server = startServer(socketPath, authToken, daemonHealth(bundlePath, startedAt, process.pid))
  // The socket file exists now — the takeover window is closed, so racing
  // starters may probe again (they will find us alive and bow out).
  claim.release()

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
      // Either the shared pairing token (Safari QR flow) or a per-device
      // credential minted through /api/pair (Home Screen app) authenticates.
      attach: (ws) => attachConnection(ws, remoteToken, isValidDeviceToken),
      exchangePairingCode,
    })
    registerBroadcastServer(remote.wss)
  } catch (err) {
    console.error(`[bond-daemon] remote server failed to start: ${err instanceof Error ? err.message : String(err)}`)
  }

  // A Desk that was running before the restart starts observing again.
  // Observed activity alone still never turns Desk on.
  startDeskIfRunning()

  console.log(`[bond-daemon] pid=${process.pid} socket=${socketPath}`)

  let shuttingDown = false
  function shutdown(exitCode: number): void {
    if (shuttingDown) return
    shuttingDown = true
    stopWatchdog()
    stopDesk()
    console.log('[bond-daemon] shutting down…')
    // If any close hangs (a lingering connection, a wedged handle), exit
    // anyway — a zombie daemon keeps holding the remote port and the next
    // daemon can't bind it.
    setTimeout(() => {
      console.error('[bond-daemon] shutdown timed out — exiting')
      removePid()
      removeToken(authToken)
      process.exit(exitCode || 1)
    }, 5000).unref()
    // MCP stdio servers are our child processes — they die with us or not at
    // all, so they close before the sockets do.
    const closeMcp = shutdownMcp().catch(() => { /* nothing left to kill */ })
    const closeRemote = closeMcp.then(() => (remote ? remote.close() : Promise.resolve()))
    closeRemote.then(() => server.close()).then(() => {
      removePid()
      removeToken(authToken)
      process.exit(exitCode)
    })
  }

  // Zombie-proofing: if the socket path vanishes or points at another file,
  // this daemon has been superseded — exit instead of lingering invisibly
  // with old clients attached. Exit 0: the successor is the daemon now, and
  // launchd must not resurrect us over it.
  const identity = socketIdentity(socketPath)
  const stopWatchdog = identity
    ? startSocketWatchdog(socketPath, identity, () => {
        console.error('[bond-daemon] socket path was taken over — exiting as orphan')
        shutdown(0)
      })
    : () => {}

  // Signal exits are deliberately nonzero: under KeepAlive/SuccessfulExit=false
  // a stray kill (or crash) resurrects the daemon, while the voluntary exits
  // above (bow-out, orphaned) stay down. launchctl bootout ignores exit codes.
  process.on('SIGTERM', () => shutdown(1))
  process.on('SIGINT', () => shutdown(1))
}

main().catch((err) => {
  console.error(`[bond-daemon] fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
