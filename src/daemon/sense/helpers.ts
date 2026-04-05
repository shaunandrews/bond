import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Resolves the path to a Sense native helper binary.
 * In dev: out/daemon/bin/sense/<name>
 * Packaged: process.resourcesPath/daemon/bin/sense/<name>
 */
export function resolveHelperPath(name: string): string {
  // Check packaged location first
  if (typeof process !== 'undefined' && (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath) {
    const packaged = join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, 'daemon', 'bin', 'sense', name)
    if (existsSync(packaged)) return packaged
  }

  // Dev fallback: project root / out/daemon/bin/sense/
  const dev = join(process.cwd(), 'out', 'daemon', 'bin', 'sense', name)
  if (existsSync(dev)) return dev

  // Last resort — just return the name and hope it's on PATH
  return name
}
