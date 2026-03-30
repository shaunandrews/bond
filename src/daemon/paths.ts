import { join } from 'node:path'
import { homedir } from 'node:os'

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
