import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import {
  createPairingCode,
  clearPairingCode,
  exchangePairingCode,
  normalizePairingCode,
  isValidDeviceToken,
  listDevices,
  revokeDevice,
  revokeAllDevices,
} from './pairing'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-pairing-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  clearPairingCode()
})

afterEach(() => {
  clearPairingCode()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('normalizePairingCode', () => {
  it('uppercases and strips separators humans type', () => {
    expect(normalizePairingCode('abcd-1234')).toBe('ABCD1234')
    expect(normalizePairingCode(' ab cd 12 34 ')).toBe('ABCD1234')
  })

  it('folds the characters the alphabet deliberately excludes', () => {
    // O/I/L are not in the alphabet, so mapping them to 0/1 can never
    // collide with a real code character.
    expect(normalizePairingCode('OIL')).toBe('011')
  })
})

describe('createPairingCode', () => {
  it('returns an 8-character code from the unambiguous alphabet', () => {
    const { code } = createPairingCode()
    expect(code).toHaveLength(8)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
  })

  it('expires five minutes out', () => {
    const now = 1_000_000
    const { expiresAt } = createPairingCode(now)
    expect(expiresAt).toBe(now + 5 * 60 * 1000)
  })

  it('invalidates the previous code — only one can be live at a time', () => {
    const first = createPairingCode()
    createPairingCode()
    expect(exchangePairingCode(first.code)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('exchangePairingCode', () => {
  it('mints a device credential for a good code', () => {
    const { code } = createPairingCode()
    const result = exchangePairingCode(code)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deviceToken).toMatch(/^[0-9a-f]{64}$/)
    expect(listDevices()).toHaveLength(1)
  })

  it('accepts a code the user typed with dashes and lowercase', () => {
    const { code } = createPairingCode()
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase()
    expect(exchangePairingCode(typed).ok).toBe(true)
  })

  it('rejects a second use of the same code', () => {
    const { code } = createPairingCode()
    expect(exchangePairingCode(code).ok).toBe(true)
    expect(exchangePairingCode(code)).toEqual({ ok: false, reason: 'used' })
    expect(listDevices()).toHaveLength(1)
  })

  it('rejects an expired code', () => {
    const now = 1_000_000
    const { code } = createPairingCode(now)
    expect(exchangePairingCode(code, now + 5 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' })
    expect(listDevices()).toHaveLength(0)
  })

  it('rejects a wrong code without minting anything', () => {
    createPairingCode()
    expect(exchangePairingCode('ZZZZZZZZ')).toEqual({ ok: false, reason: 'invalid' })
    expect(listDevices()).toHaveLength(0)
  })

  it('rejects a code of the wrong length', () => {
    createPairingCode()
    expect(exchangePairingCode('ABC')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects when no code has been generated', () => {
    expect(exchangePairingCode('ABCD1234')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('throttles after sustained guessing', () => {
    const { code } = createPairingCode()
    for (let i = 0; i < 30; i++) exchangePairingCode('ZZZZZZZZ')
    // Even the RIGHT code is refused once the budget is spent — the owner
    // has to generate a fresh one, which resets the counter.
    expect(exchangePairingCode(code)).toEqual({ ok: false, reason: 'throttled' })
  })

  it('resets the attempt budget when a new code is generated', () => {
    createPairingCode()
    for (let i = 0; i < 30; i++) exchangePairingCode('ZZZZZZZZ')
    const fresh = createPairingCode()
    expect(exchangePairingCode(fresh.code).ok).toBe(true)
  })

  it('stores only the credential hash, never the credential', () => {
    const { code } = createPairingCode()
    const result = exchangePairingCode(code)
    if (!result.ok) throw new Error('expected pairing to succeed')
    const rows = getDb().prepare('SELECT credential_hash FROM remote_devices').all() as { credential_hash: string }[]
    expect(rows[0].credential_hash).toBe(createHash('sha256').update(result.deviceToken).digest('hex'))
    expect(rows[0].credential_hash).not.toBe(result.deviceToken)
  })
})

describe('isValidDeviceToken', () => {
  function pair(): string {
    const { code } = createPairingCode()
    const result = exchangePairingCode(code)
    if (!result.ok) throw new Error('expected pairing to succeed')
    return result.deviceToken
  }

  it('accepts a live credential', () => {
    expect(isValidDeviceToken(pair())).toBe(true)
  })

  it('rejects an unknown or malformed credential', () => {
    pair()
    expect(isValidDeviceToken('f'.repeat(64))).toBe(false)
    expect(isValidDeviceToken('')).toBe(false)
    expect(isValidDeviceToken('not-hex')).toBe(false)
  })

  it('rejects a revoked credential', () => {
    const token = pair()
    revokeDevice(listDevices()[0].id)
    expect(isValidDeviceToken(token)).toBe(false)
  })

  it('stamps last_seen_at so the Mac can show which device is in use', () => {
    const token = pair()
    expect(listDevices()[0].lastSeenAt).toBeNull()
    isValidDeviceToken(token, 1_700_000_000_000)
    expect(listDevices()[0].lastSeenAt).toBe(new Date(1_700_000_000_000).toISOString())
  })
})

describe('revocation', () => {
  function pair(): string {
    const { code } = createPairingCode()
    const result = exchangePairingCode(code)
    if (!result.ok) throw new Error('expected pairing to succeed')
    return result.deviceToken
  }

  it('hides a revoked device from the list', () => {
    pair()
    revokeDevice(listDevices()[0].id)
    expect(listDevices()).toHaveLength(0)
  })

  it('revokeDevice reports whether it changed anything', () => {
    pair()
    const id = listDevices()[0].id
    expect(revokeDevice(id)).toBe(true)
    expect(revokeDevice(id)).toBe(false)
    expect(revokeDevice('no-such-device')).toBe(false)
  })

  it('revokes every device at once', () => {
    const a = pair()
    const b = pair()
    expect(revokeAllDevices()).toBe(2)
    expect(isValidDeviceToken(a)).toBe(false)
    expect(isValidDeviceToken(b)).toBe(false)
    expect(listDevices()).toHaveLength(0)
  })

  it('leaves other devices alone when one is revoked', () => {
    const a = pair()
    const b = pair()
    // last_seen_at identifies which row is which without exposing credentials.
    isValidDeviceToken(a, 1_700_000_000_000)
    const rowA = listDevices().find(d => d.lastSeenAt !== null)
    expect(rowA).toBeDefined()

    revokeDevice(rowA!.id)
    expect(isValidDeviceToken(a)).toBe(false)
    expect(isValidDeviceToken(b)).toBe(true)
    expect(listDevices()).toHaveLength(1)
  })
})
