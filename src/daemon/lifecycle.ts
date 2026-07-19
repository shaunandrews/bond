/**
 * Daemon single-instance lifecycle.
 *
 * Bond must have exactly one serving daemon. Three cooperating guarantees
 * enforce that, independent of pid files (which lie the moment a process
 * they don't track exists):
 *
 * 1. Claim — socket takeover is serialized through an O_EXCL lock file and
 *    gated on a live-connection probe. Only a provably dead socket may be
 *    unlinked, and a racing second starter sees the winner and bows out.
 * 2. Watchdog — after binding, the daemon remembers the socket file's
 *    identity (dev+ino) and re-checks it periodically. If the path vanishes
 *    or points at a different socket, this daemon has been orphaned and must
 *    exit instead of lingering as an invisible zombie serving old clients.
 * 3. Health — GET /health on the unix socket reports the serving pid and
 *    the bundle's build time, so tooling asks the socket who is serving
 *    instead of trusting a pid file.
 */

import { connect } from 'node:net'
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { PROTOCOL_VERSION } from '../shared/protocol'

/**
 * True when something accepts connections on the socket path. ENOENT,
 * ECONNREFUSED, and ENOTSOCK all mean no live daemon. A connect that hangs
 * (never happens for unix sockets in practice) counts as alive — when in
 * doubt, never steal the socket.
 */
export function probeSocketAlive(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath)
    let settled = false
    const done = (alive: boolean): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(alive)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(timeoutMs, () => done(true))
  })
}

export interface StartLockOptions {
  /** A lock file older than this is from a crashed starter and may be broken. */
  staleMs?: number
  /** Give up acquiring after this long. */
  timeoutMs?: number
  /** Poll interval while the lock is contested. */
  pollMs?: number
}

export interface StartLock {
  release: () => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Exclusive advisory lock for the probe→unlink→bind window. O_EXCL creation
 * is atomic, so two racing starters serialize; a holder that crashed leaves
 * a file whose age exceeds staleMs and gets broken.
 */
export async function acquireStartLock(lockPath: string, options: StartLockOptions = {}): Promise<StartLock> {
  const { staleMs = 10_000, timeoutMs = 8_000, pollMs = 150 } = options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return { release: () => { try { unlinkSync(lockPath) } catch { /* already gone */ } } }
    } catch {
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs
        if (age > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch { /* holder released between open and stat — retry immediately */ continue }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for daemon start lock at ${lockPath}`)
      await sleep(pollMs)
    }
  }
}

export interface SocketClaim {
  /** False when a live daemon already serves the socket — the caller must exit. */
  claimed: boolean
  /** Release the start lock. Call only AFTER binding the socket. */
  release: () => void
}

/**
 * Decide, under the start lock, whether this process may bind the socket.
 * A dead leftover socket file is removed; a live one means bow out. The
 * returned release() must be called after the bind so no other starter can
 * probe-and-unlink in the window between our unlink and our listen.
 */
export async function claimSocket(socketPath: string, lockPath: string, options: StartLockOptions = {}): Promise<SocketClaim> {
  const lock = await acquireStartLock(lockPath, options)
  if (await probeSocketAlive(socketPath)) {
    lock.release()
    return { claimed: false, release: () => {} }
  }
  try { unlinkSync(socketPath) } catch { /* no stale file — nothing to clear */ }
  return { claimed: true, release: lock.release }
}

export interface SocketIdentity {
  dev: number
  ino: number
}

/** Filesystem identity of the bound socket file, or null if it can't be read. */
export function socketIdentity(socketPath: string): SocketIdentity | null {
  try {
    const s = statSync(socketPath)
    return { dev: s.dev, ino: s.ino }
  } catch {
    return null
  }
}

/** True when the socket path no longer points at the file we bound. */
export function socketLost(socketPath: string, identity: SocketIdentity): boolean {
  const now = socketIdentity(socketPath)
  return !now || now.dev !== identity.dev || now.ino !== identity.ino
}

/**
 * Poll the socket path; fire onLost once if it disappears or is replaced.
 * This is the zombie-proofing: a daemon that loses its socket has been
 * superseded and exits, no matter what spawned the successor.
 */
export function startSocketWatchdog(
  socketPath: string,
  identity: SocketIdentity,
  onLost: () => void,
  intervalMs = 15_000
): () => void {
  const timer = setInterval(() => {
    if (socketLost(socketPath, identity)) {
      clearInterval(timer)
      onLost()
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

export interface DaemonHealth {
  pid: number
  startedAt: string
  bundlePath: string | null
  /** mtime of the bundle this process loaded — lets tooling flag a daemon older than the bundle on disk. */
  bundleMtimeMs: number | null
  /** RPC contract version this daemon speaks (shared/protocol.ts PROTOCOL_VERSION). */
  protocolVersion: number
}

/**
 * Build the health payload. Call ONCE at daemon startup and serve the frozen
 * snapshot — stat-ing the bundle per request would pick up later rebuilds and
 * mask the daemon-older-than-bundle condition the payload exists to expose.
 */
export function daemonHealth(bundlePath: string | null, startedAt: Date, pid: number): DaemonHealth {
  let bundleMtimeMs: number | null = null
  if (bundlePath) {
    try { bundleMtimeMs = Math.floor(statSync(bundlePath).mtimeMs) } catch { /* bundle moved or deleted since load */ }
  }
  return { pid, startedAt: startedAt.toISOString(), bundlePath, bundleMtimeMs, protocolVersion: PROTOCOL_VERSION }
}
