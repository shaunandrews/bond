import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import {
  probeSocketAlive,
  acquireStartLock,
  claimSocket,
  socketIdentity,
  socketLost,
  startSocketWatchdog,
  daemonHealth
} from './lifecycle'

let dir: string
let servers: Server[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bond-lc-'))
  servers = []
})

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  rmSync(dir, { recursive: true, force: true })
})

function listen(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen(socketPath, () => resolve(server))
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('probeSocketAlive', () => {
  it('is false when the path does not exist', async () => {
    expect(await probeSocketAlive(join(dir, 'missing.sock'))).toBe(false)
  })

  it('is false for a dead leftover file', async () => {
    const path = join(dir, 'stale.sock')
    writeFileSync(path, '')
    expect(await probeSocketAlive(path)).toBe(false)
  })

  it('is true when a server is listening', async () => {
    const path = join(dir, 'live.sock')
    await listen(path)
    expect(await probeSocketAlive(path)).toBe(true)
  })
})

describe('acquireStartLock', () => {
  it('creates the lock file and release removes it', async () => {
    const lockPath = join(dir, 'lock')
    const lock = await acquireStartLock(lockPath)
    expect(existsSync(lockPath)).toBe(true)
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('times out while another holder is live', async () => {
    const lockPath = join(dir, 'lock')
    const lock = await acquireStartLock(lockPath)
    await expect(
      acquireStartLock(lockPath, { timeoutMs: 300, pollMs: 50 })
    ).rejects.toThrow(/timed out/)
    lock.release()
  })

  it('breaks a stale lock from a crashed starter', async () => {
    const lockPath = join(dir, 'lock')
    writeFileSync(lockPath, '99999')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)
    const lock = await acquireStartLock(lockPath, { staleMs: 10_000, timeoutMs: 500 })
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('can be re-acquired after release', async () => {
    const lockPath = join(dir, 'lock')
    const first = await acquireStartLock(lockPath)
    first.release()
    const second = await acquireStartLock(lockPath, { timeoutMs: 300 })
    second.release()
  })
})

describe('claimSocket', () => {
  it('claims when no socket exists, holding the lock until release', async () => {
    const socketPath = join(dir, 'bond.sock')
    const lockPath = join(dir, 'starting')
    const claim = await claimSocket(socketPath, lockPath)
    expect(claim.claimed).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
    claim.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('bows out when a live daemon serves the socket, leaving it untouched', async () => {
    const socketPath = join(dir, 'bond.sock')
    const lockPath = join(dir, 'starting')
    await listen(socketPath)
    const claim = await claimSocket(socketPath, lockPath)
    expect(claim.claimed).toBe(false)
    expect(existsSync(lockPath)).toBe(false)
    expect(await probeSocketAlive(socketPath)).toBe(true)
  })

  it('removes a dead leftover socket file and claims', async () => {
    const socketPath = join(dir, 'bond.sock')
    const lockPath = join(dir, 'starting')
    writeFileSync(socketPath, '')
    const claim = await claimSocket(socketPath, lockPath)
    expect(claim.claimed).toBe(true)
    expect(existsSync(socketPath)).toBe(false)
    claim.release()
  })
})

describe('socketIdentity / socketLost', () => {
  it('recognizes its own socket file', () => {
    const path = join(dir, 'f')
    writeFileSync(path, '')
    const identity = socketIdentity(path)
    expect(identity).not.toBeNull()
    expect(socketLost(path, identity!)).toBe(false)
  })

  it('reports lost when the file is gone', () => {
    const path = join(dir, 'f')
    writeFileSync(path, '')
    const identity = socketIdentity(path)!
    unlinkSync(path)
    expect(socketLost(path, identity)).toBe(true)
  })

  it('returns null identity for a missing path', () => {
    expect(socketIdentity(join(dir, 'missing'))).toBeNull()
  })
})

describe('startSocketWatchdog', () => {
  it('fires onLost once when the socket path disappears', async () => {
    const path = join(dir, 'f')
    writeFileSync(path, '')
    const identity = socketIdentity(path)!
    let fired = 0
    startSocketWatchdog(path, identity, () => { fired++ }, 20)
    unlinkSync(path)
    await waitFor(() => fired > 0)
    await new Promise((r) => setTimeout(r, 80))
    expect(fired).toBe(1)
  })

  it('does not fire after stop', async () => {
    const path = join(dir, 'f')
    writeFileSync(path, '')
    const identity = socketIdentity(path)!
    let fired = 0
    const stop = startSocketWatchdog(path, identity, () => { fired++ }, 20)
    stop()
    unlinkSync(path)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toBe(0)
  })
})

describe('daemonHealth', () => {
  it('reports pid, start time, and the bundle mtime', () => {
    const bundle = join(dir, 'main.mjs')
    writeFileSync(bundle, '// bundle')
    const startedAt = new Date('2026-07-19T12:00:00Z')
    const health = daemonHealth(bundle, startedAt, 4321)
    expect(health.pid).toBe(4321)
    expect(health.startedAt).toBe('2026-07-19T12:00:00.000Z')
    expect(health.bundlePath).toBe(bundle)
    expect(health.bundleMtimeMs).toBe(Math.floor(statSync(bundle).mtimeMs))
  })

  it('tolerates a missing bundle path', () => {
    const health = daemonHealth(null, new Date(), 1)
    expect(health.bundlePath).toBeNull()
    expect(health.bundleMtimeMs).toBeNull()
  })
})
