import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { closeDb, getDb } from './db'
import { getDataDir, setDataDir } from './paths'

/**
 * New-user sandbox: swaps the daemon's entire data directory to a fresh, empty
 * sandbox so the REAL app runs against a brand-new install. Everything rooted in
 * getDataDir() — SQLite, core memory, images, Pi sessions, downloads — is
 * isolated for free. Exiting restores the real directory and deletes the sandbox.
 *
 * Sandbox state is intentionally in-memory only: if the daemon restarts, it
 * comes back up on the real data directory and the stale sandbox is wiped on
 * the next enter.
 */

let realDataDir: string | null = null

export function isSandboxed(): boolean {
  return realDataDir !== null
}

export function sandboxDirPath(baseDir: string): string {
  return join(baseDir, 'sandbox')
}

export function enterSandbox(): { dataDir: string } {
  if (realDataDir) throw new Error('Already in the new-user sandbox.')
  const base = getDataDir()
  const sandboxDir = sandboxDirPath(base)
  // Always start from a genuinely empty install.
  rmSync(sandboxDir, { recursive: true, force: true })
  mkdirSync(sandboxDir, { recursive: true })
  closeDb()
  realDataDir = base
  try {
    setDataDir(sandboxDir)
    getDb() // run migrations on the fresh database
  } catch (error) {
    // Roll back to the real directory rather than stranding the daemon.
    setDataDir(base)
    realDataDir = null
    getDb()
    throw error
  }
  return { dataDir: sandboxDir }
}

export function exitSandbox(): void {
  if (!realDataDir) throw new Error('Not in the new-user sandbox.')
  const base = realDataDir
  closeDb()
  setDataDir(base)
  realDataDir = null
  getDb()
  rmSync(sandboxDirPath(base), { recursive: true, force: true })
}
