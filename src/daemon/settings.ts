import { randomBytes } from 'node:crypto'
import { normalizeModelTier, type ModelId } from '../shared/models'
import type { AgentSettings } from '../shared/agents'
import { DEFAULT_SENSE_SETTINGS, type SenseSettings } from '../shared/sense'
import { getDb } from './db'

export function getSetting(key: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): boolean {
  const db = getDb()
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  return true
}

export function getSoul(): string {
  return getSetting('soul') ?? ''
}

export function saveSoul(content: string): boolean {
  return setSetting('soul', content)
}

export function getModelSetting(): ModelId {
  return normalizeModelTier(getSetting('model') ?? undefined)
}

export function saveModelSetting(model: ModelId): boolean {
  return setSetting('model', model)
}

export function getAccentColor(): string {
  return getSetting('accent_color') ?? ''
}

export function saveAccentColor(hex: string): boolean {
  return setSetting('accent_color', hex.trim())
}

export function getWindowOpacity(): number {
  const raw = getSetting('window_opacity')
  if (raw !== null) {
    const n = parseFloat(raw)
    if (!isNaN(n) && n >= 0 && n <= 1) return n
  }
  return 1
}

export function saveWindowOpacity(opacity: number): boolean {
  const clamped = Math.max(0, Math.min(1, opacity))
  return setSetting('window_opacity', String(clamped))
}

/** Persisted Sense settings merged over the defaults; garbage in the row falls back to defaults. */
export function getSenseSettings(): SenseSettings {
  try {
    const raw = getSetting('sense')
    if (raw) return { ...DEFAULT_SENSE_SETTINGS, ...JSON.parse(raw) }
  } catch { /* use defaults */ }
  return DEFAULT_SENSE_SETTINGS
}

export function setSenseSettings(settings: SenseSettings): void {
  setSetting('sense', JSON.stringify(settings))
}

/**
 * Per-agent settings overrides, layered over the definition's frontmatter
 * defaults by `effectiveAgentSettings`. Stored one JSON blob per agent so an
 * agent that disappears leaves no stray keys behind.
 */
export function getAgentSettingsOverride(name: string): Partial<AgentSettings> {
  try {
    const raw = getSetting(`agents.${name}`)
    if (raw) return JSON.parse(raw) as Partial<AgentSettings>
  } catch { /* fall through to definition defaults */ }
  return {}
}

export function setAgentSettingsOverride(name: string, settings: AgentSettings): void {
  setSetting(`agents.${name}`, JSON.stringify(settings))
}

/**
 * Approved evidence-runner commands, keyed by command hash. Runners execute
 * outside the per-turn approval flow, and Bond can author agent definition
 * files — so a command runs only after the user has approved that exact
 * string once.
 */
export function getApprovedRunnerHashes(): string[] {
  try {
    const raw = getSetting('agents.runnerApprovals')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string')
    }
  } catch { /* treat unreadable approvals as none approved */ }
  return []
}

export function approveRunnerHash(hash: string): void {
  const approved = new Set(getApprovedRunnerHashes())
  approved.add(hash)
  setSetting('agents.runnerApprovals', JSON.stringify([...approved]))
}

export function revokeRunnerHash(hash: string): void {
  setSetting('agents.runnerApprovals', JSON.stringify(getApprovedRunnerHashes().filter(entry => entry !== hash)))
}

// Reserved via Port Keeper (`portman list`) so local dev servers don't collide.
export const DEFAULT_REMOTE_PORT = 3113

export function getRemotePort(): number {
  const raw = getSetting('remote.port')
  if (raw !== null) {
    const n = parseInt(raw, 10)
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
  }
  return DEFAULT_REMOTE_PORT
}

/**
 * The pairing token for the remote LAN server. Persisted — unlike the
 * per-start daemon token — so a phone's stored pairing survives restarts.
 */
export function getOrCreateRemoteToken(): string {
  const existing = getSetting('remote.token')
  if (existing) return existing
  const token = randomBytes(32).toString('hex')
  setSetting('remote.token', token)
  return token
}
