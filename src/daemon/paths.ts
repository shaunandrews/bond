import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

/**
 * Returns the data directory for Bond.
 * When running inside Electron, this is overridden to use app.getPath('userData').
 * When running as a standalone daemon, defaults to ~/Library/Application Support/bond.
 */
let _dataDir: string | null = null

export function setDataDir(dir: string): void {
  _dataDir = dir
}

export function getDataDir(): string {
  if (_dataDir) return _dataDir
  // Default: macOS Application Support path (matches Electron's default for app name "bond")
  return join(homedir(), 'Library', 'Application Support', 'bond')
}

export function getDbPath(): string {
  return join(getDataDir(), 'bond.db')
}

/**
 * Skills directory — ~/.bond/skills/
 * Skills are SKILL.md files loaded by the Agent SDK via the plugins system.
 */
export function getSkillsDir(): string {
  return join(homedir(), '.bond', 'skills')
}

/**
 * Ensure the skills directory exists so users have a place to put skills.
 */
export function ensureSkillsDir(): void {
  mkdirSync(getSkillsDir(), { recursive: true })
}
