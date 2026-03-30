import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WordPressSite } from '../shared/wordpress'

function findStudioBinary(): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', 'which studio'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

export function listSites(): { available: boolean; sites: WordPressSite[] } {
  const bin = findStudioBinary()
  if (!bin) return { available: false, sites: [] }

  try {
    const raw = execFileSync(bin, ['site', 'list', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 10_000
    })
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { available: true, sites: [] }

    const sites: WordPressSite[] = parsed.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? ''),
      path: String(s.path ?? ''),
      port: Number(s.port ?? 0),
      url: String(s.url ?? ''),
      running: Boolean(s.running)
    }))

    return { available: true, sites }
  } catch {
    return { available: true, sites: [] }
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function createSite(name: string): { available: boolean; sites: WordPressSite[] } {
  const bin = findStudioBinary()
  if (!bin) return { available: false, sites: [] }

  const slug = slugify(name)
  const sitePath = join(homedir(), 'Studio', slug)

  try {
    execFileSync(bin, [
      'site', 'create',
      '--name', name,
      '--path', sitePath,
      '--start', 'true',
      '--skip-browser', 'true'
    ], {
      encoding: 'utf-8',
      timeout: 60_000
    })
  } catch (e) {
    console.error('[wordpress] create failed:', e instanceof Error ? e.message : e)
  }

  // Always return fresh list regardless of create outcome
  return listSites()
}

export function startSite(path: string): { available: boolean; sites: WordPressSite[] } {
  const bin = findStudioBinary()
  if (!bin) return { available: false, sites: [] }

  try {
    execFileSync(bin, ['site', 'start', '--path', path, '--skip-browser', 'true'], {
      encoding: 'utf-8',
      timeout: 30_000
    })
  } catch (e) {
    console.error('[wordpress] start failed:', e instanceof Error ? e.message : e)
  }

  return listSites()
}

export function stopSite(path: string): { available: boolean; sites: WordPressSite[] } {
  const bin = findStudioBinary()
  if (!bin) return { available: false, sites: [] }

  try {
    execFileSync(bin, ['site', 'stop', '--path', path], {
      encoding: 'utf-8',
      timeout: 30_000
    })
  } catch (e) {
    console.error('[wordpress] stop failed:', e instanceof Error ? e.message : e)
  }

  return listSites()
}
