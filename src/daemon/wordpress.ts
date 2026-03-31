import { execFile, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WordPressSite, WordPressSiteDetails, WpContent } from '../shared/wordpress'

const execFileAsync = promisify(execFile)

// --- Binary resolution (cached) ---

let cachedBin: string | null | undefined
function findStudioBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin
  try {
    cachedBin = execFileSync('/bin/sh', ['-c', 'which studio'], { encoding: 'utf-8' }).trim()
  } catch {
    cachedBin = null
  }
  return cachedBin
}

// --- Site details cache ---

const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes
const REFRESH_INTERVAL_MS = 60 * 1000 // 1 minute

interface CacheEntry {
  details: WordPressSiteDetails
  fetchedAt: number
}

const detailsCache = new Map<string, CacheEntry>()
// Track in-flight fetches to avoid duplicate work
const inflightFetches = new Map<string, Promise<WordPressSiteDetails | null>>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let lastSites: WordPressSite[] = []

function isCacheFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS
}

/** Returns cached details immediately, or null. Triggers background refresh if stale. */
export function getCachedSiteDetails(path: string): WordPressSiteDetails | null {
  const entry = detailsCache.get(path)
  if (entry) {
    if (!isCacheFresh(entry)) {
      // Stale — refresh in background, still return cached
      refreshSiteDetails(path)
    }
    return entry.details
  }
  // No cache — trigger fetch, return null for now
  refreshSiteDetails(path)
  return null
}

/** Fetches details in background and updates cache. Returns the promise for callers that want to wait. */
export function refreshSiteDetails(path: string): Promise<WordPressSiteDetails | null> {
  // Deduplicate in-flight fetches
  const existing = inflightFetches.get(path)
  if (existing) return existing

  const promise = fetchSiteDetails(path).then(details => {
    if (details) {
      detailsCache.set(path, { details, fetchedAt: Date.now() })
    } else {
      detailsCache.delete(path)
    }
    inflightFetches.delete(path)
    return details
  }).catch(e => {
    console.error('[wordpress] refreshSiteDetails failed:', e instanceof Error ? e.message : e)
    inflightFetches.delete(path)
    return null
  })

  inflightFetches.set(path, promise)
  return promise
}

/** Invalidate cache for a path (e.g. after stop/delete) */
function invalidateDetails(path: string): void {
  detailsCache.delete(path)
}

/** Refresh details for all currently running sites */
function refreshAllRunning(): void {
  for (const site of lastSites) {
    if (site.running) {
      refreshSiteDetails(site.path)
    }
  }
}

/** Start periodic background refresh */
export function startBackgroundRefresh(): void {
  if (refreshTimer) return
  refreshTimer = setInterval(refreshAllRunning, REFRESH_INTERVAL_MS)
}

/** Stop periodic refresh (call on daemon shutdown) */
export function stopBackgroundRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

// --- Async WP-CLI helper ---

async function wpCliAsync(bin: string, sitePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, ['wp', '--path', sitePath, ...args], {
    encoding: 'utf-8',
    timeout: 15_000
  })
  return stdout
}

async function fetchSiteDetails(path: string): Promise<WordPressSiteDetails | null> {
  const bin = findStudioBinary()
  if (!bin) return null

  try {
    const wpVersion = (await wpCliAsync(bin, path, ['core', 'version'])).trim()

    let siteTitle = ''
    try { siteTitle = (await wpCliAsync(bin, path, ['option', 'get', 'blogname'])).trim() } catch { /* */ }

    let tagline = ''
    try { tagline = (await wpCliAsync(bin, path, ['option', 'get', 'blogdescription'])).trim() } catch { /* */ }

    let permalinkStructure = ''
    try { permalinkStructure = (await wpCliAsync(bin, path, ['option', 'get', 'permalink_structure'])).trim() } catch { /* */ }

    const themesRaw = JSON.parse(await wpCliAsync(bin, path, ['theme', 'list', '--format=json']))
    const themes = Array.isArray(themesRaw)
      ? themesRaw.map((t: Record<string, unknown>) => ({
          name: String(t.name ?? ''),
          status: String(t.status ?? ''),
          version: String(t.version ?? '')
        }))
      : []

    const pluginsRaw = JSON.parse(await wpCliAsync(bin, path, ['plugin', 'list', '--format=json']))
    const plugins = Array.isArray(pluginsRaw)
      ? pluginsRaw
          .filter((p: Record<string, unknown>) => p.status !== 'dropin' && p.status !== 'must-use')
          .map((p: Record<string, unknown>) => ({
            name: String(p.name ?? ''),
            status: String(p.status ?? ''),
            version: String(p.version ?? ''),
            updateVersion: String(p.update_version ?? '')
          }))
      : []

    const templatesRaw = JSON.parse(await wpCliAsync(bin, path, ['post', 'list', '--post_type=wp_template', '--format=json']))
    const templates = Array.isArray(templatesRaw)
      ? templatesRaw.map((t: Record<string, unknown>) => ({
          title: String(t.post_title ?? ''),
          name: String(t.post_name ?? '')
        }))
      : []

    let postCount = 0
    try {
      postCount = parseInt((await wpCliAsync(bin, path, ['post', 'list', '--post_type=post', '--post_status=publish', '--format=count'])).trim(), 10) || 0
    } catch { /* non-critical */ }

    let pageCount = 0
    try {
      pageCount = parseInt((await wpCliAsync(bin, path, ['post', 'list', '--post_type=page', '--post_status=publish', '--format=count'])).trim(), 10) || 0
    } catch { /* non-critical */ }

    let userCount = 0
    try {
      userCount = parseInt((await wpCliAsync(bin, path, ['user', 'list', '--format=count'])).trim(), 10) || 0
    } catch { /* non-critical */ }

    // Fetch published pages and posts with their content
    const content: WpContent[] = []
    try {
      for (const postType of ['page', 'post'] as const) {
        const listRaw = await wpCliAsync(bin, path, [
          'post', 'list', `--post_type=${postType}`, '--post_status=publish',
          '--fields=ID,post_title,post_name', '--format=json'
        ])
        const items = JSON.parse(listRaw)
        if (!Array.isArray(items)) continue
        for (const item of items.slice(0, 20)) {
          try {
            let body = (await wpCliAsync(bin, path, ['post', 'get', String(item.ID), '--field=post_content'])).trim()
            if (body.length > 2000) body = body.substring(0, 2000) + '\n[...truncated]'
            content.push({
              id: Number(item.ID),
              title: String(item.post_title ?? ''),
              slug: String(item.post_name ?? ''),
              type: postType,
              content: body
            })
          } catch { /* skip individual posts that fail */ }
        }
      }
    } catch { /* non-critical */ }

    return { wpVersion, siteTitle, tagline, permalinkStructure, themes, plugins, templates, postCount, pageCount, userCount, content }
  } catch (e) {
    console.error('[wordpress] fetchSiteDetails failed:', e instanceof Error ? e.message : e)
    return null
  }
}

// --- Sync site management (these are fast, single CLI calls) ---

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
      running: Boolean(s.running),
      phpVersion: String(s.phpVersion ?? ''),
      enableHttps: Boolean(s.enableHttps),
      adminUsername: String(s.adminUsername ?? ''),
      adminEmail: String(s.adminEmail ?? ''),
      isWpAutoUpdating: Boolean(s.isWpAutoUpdating),
      autoStart: Boolean(s.autoStart),
      customDomain: s.customDomain ? String(s.customDomain) : undefined,
      enableXdebug: s.enableXdebug != null ? Boolean(s.enableXdebug) : undefined,
      enableDebugLog: s.enableDebugLog != null ? Boolean(s.enableDebugLog) : undefined,
      enableDebugDisplay: s.enableDebugDisplay != null ? Boolean(s.enableDebugDisplay) : undefined
    }))

    lastSites = sites
    // Pre-fetch details for any running sites
    for (const site of sites) {
      if (site.running && !detailsCache.has(site.path)) {
        refreshSiteDetails(site.path)
      }
    }

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

  const result = listSites()
  // Site just started — fetch details in background
  refreshSiteDetails(path)
  return result
}

export function deleteSite(path: string): { available: boolean; sites: WordPressSite[] } {
  const bin = findStudioBinary()
  if (!bin) return { available: false, sites: [] }

  try {
    execFileSync(bin, ['site', 'delete', '--path', path, '--files'], {
      encoding: 'utf-8',
      timeout: 30_000
    })
  } catch (e) {
    console.error('[wordpress] delete failed:', e instanceof Error ? e.message : e)
  }

  invalidateDetails(path)
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

  invalidateDetails(path)
  return listSites()
}
