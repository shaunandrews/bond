import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { getDb } from './db'

/**
 * Device pairing for the remote LAN web client.
 *
 * The Home Screen web app on iOS has its own storage context — it cannot read
 * the `#t=…` token Safari stashed in localStorage, so a QR scan in Safari does
 * nothing for the installed app. Instead the Mac shows a short-lived code, the
 * installed app POSTs it to `/api/pair`, and gets back its own device
 * credential which it stores in its own origin storage.
 *
 * The code is a one-time bootstrap grant, never a rendering of the long-lived
 * `remote.token`. Codes live in memory only (an interrupted pairing is just
 * retried after a daemon restart); credentials persist, hashed, in SQLite.
 */

/** Crockford-ish base32 minus I/L/O/U — no character pairs a human can confuse. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const CODE_TTL_MS = 5 * 60 * 1000
/** Brute force needs 32^8 ≈ 1.1e12 guesses; this makes even a LAN attacker's odds nil. */
const MAX_ATTEMPTS = 30

export interface PairingCode {
  code: string
  expiresAt: number
}

export interface RemoteDevice {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string | null
}

export type PairingFailure = 'invalid' | 'expired' | 'used' | 'throttled'

export type PairingResult =
  | { ok: true; deviceToken: string; deviceId: string }
  | { ok: false; reason: PairingFailure }

interface PendingCode {
  hash: string
  expiresAt: number
  used: boolean
}

// At most one code is live at a time — generating a new one invalidates the
// old, so a stale code left on screen can never still pair.
let pending: PendingCode | null = null
let attempts = 0

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Constant-time compare of two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

export function normalizePairingCode(raw: string): string {
  // Humans type spaces, dashes, and lowercase; O/I are the classic mistypes
  // for 0/1 and aren't in the alphabet, so folding them is always safe.
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

export function createPairingCode(now = Date.now()): PairingCode {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]

  const expiresAt = now + CODE_TTL_MS
  pending = { hash: hash(code), expiresAt, used: false }
  attempts = 0
  return { code, expiresAt }
}

/** Test/reset seam — drops any live code so suites don't leak state. */
export function clearPairingCode(): void {
  pending = null
  attempts = 0
}

export function exchangePairingCode(rawCode: string, now = Date.now()): PairingResult {
  if (!pending) return { ok: false, reason: 'invalid' }
  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'throttled' }
  attempts++

  if (pending.used) return { ok: false, reason: 'used' }
  if (now >= pending.expiresAt) return { ok: false, reason: 'expired' }

  const candidate = normalizePairingCode(rawCode)
  if (candidate.length !== CODE_LENGTH) return { ok: false, reason: 'invalid' }
  if (!hashesMatch(hash(candidate), pending.hash)) return { ok: false, reason: 'invalid' }

  // Burn the code before minting anything — a concurrent second POST with the
  // same code must lose, even if credential creation below were to throw.
  pending.used = true

  const deviceToken = randomBytes(32).toString('hex')
  const deviceId = randomUUID()
  getDb()
    .prepare('INSERT INTO remote_devices (id, credential_hash, label, created_at) VALUES (?, ?, ?, ?)')
    .run(deviceId, hash(deviceToken), '', new Date(now).toISOString())

  return { ok: true, deviceToken, deviceId }
}

/**
 * Does this token belong to a live device? Also stamps last_seen_at so the
 * Mac's device list can show which phone is actually in use.
 */
export function isValidDeviceToken(token: string, now = Date.now()): boolean {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false
  const row = getDb()
    .prepare('SELECT id, revoked_at FROM remote_devices WHERE credential_hash = ?')
    .get(hash(token)) as { id: string; revoked_at: string | null } | undefined
  if (!row || row.revoked_at) return false

  getDb()
    .prepare('UPDATE remote_devices SET last_seen_at = ? WHERE id = ?')
    .run(new Date(now).toISOString(), row.id)
  return true
}

export function listDevices(): RemoteDevice[] {
  const rows = getDb()
    .prepare(
      'SELECT id, label, created_at, last_seen_at FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at DESC'
    )
    .all() as { id: string; label: string; created_at: string; last_seen_at: string | null }[]
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }))
}

export function revokeDevice(id: string, now = Date.now()): boolean {
  const info = getDb()
    .prepare('UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(new Date(now).toISOString(), id)
  return info.changes > 0
}

export function revokeAllDevices(now = Date.now()): number {
  const info = getDb()
    .prepare('UPDATE remote_devices SET revoked_at = ? WHERE revoked_at IS NULL')
    .run(new Date(now).toISOString())
  return info.changes
}
