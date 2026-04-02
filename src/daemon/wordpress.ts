import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WordPressSite, WordPressSiteDetails, WpContent, WpSiteMap, WpSiteMapNode, WpThemeJson } from '../shared/wordpress'

const execFileAsync = promisify(execFile)

// Suppress Studio CLI stderr from leaking into daemon.log
const SILENT_STDIO: [string, string, string] = ['pipe', 'pipe', 'pipe']

// --- Binary resolution (cached) ---

let cachedBin: string | null | undefined
function findStudioBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin

  // 1. Try current PATH (works when main process resolved it for packaged app)
  try {
    const result = execFileSync('/bin/sh', ['-c', 'which studio'], {
      encoding: 'utf-8',
      stdio: SILENT_STDIO,
    }).trim()
    if (result && existsSync(result)) { cachedBin = result; return cachedBin }
  } catch { /* fall through */ }

  // 2. Login shell — picks up Homebrew/nvm/fnm paths from ~/.zshrc
  try {
    const result = execFileSync('/bin/zsh', ['-l', '-c', 'which studio'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: SILENT_STDIO,
    }).trim()
    if (result && existsSync(result)) { cachedBin = result; return cachedBin }
  } catch { /* fall through */ }

  // 3. Well-known filesystem paths
  const candidates = [
    '/opt/homebrew/bin/studio',  // Homebrew on Apple Silicon
    '/usr/local/bin/studio',     // Homebrew on Intel / manual install
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) { cachedBin = candidate; return cachedBin }
  }

  cachedBin = null
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

// Site map cache
interface SiteMapCacheEntry { siteMap: WpSiteMap; fetchedAt: number }
const siteMapCache = new Map<string, SiteMapCacheEntry>()
const inflightSiteMapFetches = new Map<string, Promise<WpSiteMap | null>>()

// Theme JSON cache
interface ThemeJsonCacheEntry { themeJson: WpThemeJson; fetchedAt: number }
const themeJsonCache = new Map<string, ThemeJsonCacheEntry>()
const inflightThemeJsonFetches = new Map<string, Promise<WpThemeJson | null>>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let lastSites: WordPressSite[] = []

function isCacheFresh(entry: { fetchedAt: number }): boolean {
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
  siteMapCache.delete(path)
  themeJsonCache.delete(path)
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

// --- WP Admin login cookies ---

export interface WpLoginCookie {
  name: string
  value: string
  path: string
  expires: number
}

export interface WpLoginCookies {
  cookies: WpLoginCookie[]
}

export async function generateLoginCookies(path: string): Promise<WpLoginCookies | null> {
  const bin = findStudioBinary()
  if (!bin) return null

  try {
    const raw = await wpCliAsync(bin, path, ['eval', `
$user = get_user_by("login", "admin");
if (!$user) $user = get_user_by("ID", 1);
$expiration = time() + DAY_IN_SECONDS;
$auth = wp_generate_auth_cookie($user->ID, $expiration, "auth");
$logged_in = wp_generate_auth_cookie($user->ID, $expiration, "logged_in");
echo json_encode([
  "cookies" => [
    ["name" => AUTH_COOKIE, "value" => $auth, "path" => ADMIN_COOKIE_PATH, "expires" => (int) $expiration],
    ["name" => SECURE_AUTH_COOKIE, "value" => $auth, "path" => ADMIN_COOKIE_PATH, "expires" => (int) $expiration],
    ["name" => LOGGED_IN_COOKIE, "value" => $logged_in, "path" => COOKIEPATH, "expires" => (int) $expiration],
  ]
]);
`])
    const data = JSON.parse(raw.trim())
    return {
      cookies: data.cookies.map((c: Record<string, unknown>) => ({
        name: String(c.name),
        value: String(c.value),
        path: String(c.path),
        expires: Number(c.expires)
      }))
    }
  } catch (e) {
    console.error('[wordpress] generateLoginCookies failed:', e instanceof Error ? e.message : e)
    return null
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
          '--fields=ID,post_title,post_name,post_parent', '--format=json'
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
              content: body,
              parent: Number(item.post_parent ?? 0)
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

// --- Site Map ---

async function fetchSiteMap(path: string): Promise<WpSiteMap | null> {
  const bin = findStudioBinary()
  if (!bin) return null

  try {
    // Run all CLI calls in parallel for speed
    const [pagesStr, postsStr, showOnFrontStr, pageOnFrontStr, siteUrlStr] = await Promise.all([
      wpCliAsync(bin, path, [
        'post', 'list', '--post_type=page', '--post_status=publish',
        '--fields=ID,post_title,post_name,post_parent', '--format=json'
      ]).catch(() => '[]'),
      wpCliAsync(bin, path, [
        'post', 'list', '--post_type=post', '--post_status=publish',
        '--fields=ID,post_title,post_name', '--format=json'
      ]).catch(() => '[]'),
      wpCliAsync(bin, path, ['option', 'get', 'show_on_front']).catch(() => 'posts'),
      wpCliAsync(bin, path, ['option', 'get', 'page_on_front']).catch(() => '0'),
      wpCliAsync(bin, path, ['option', 'get', 'siteurl']).catch(() => '')
    ])

    const pagesRaw = JSON.parse(pagesStr)
    const postsRaw = JSON.parse(postsStr)
    const showOnFront = showOnFrontStr.trim()
    const pageOnFront = parseInt(pageOnFrontStr.trim(), 10) || 0
    const siteUrl = siteUrlStr.trim()
    const homePageId = showOnFront === 'page' ? pageOnFront : null

    // Build page nodes
    const pageNodes: WpSiteMapNode[] = (Array.isArray(pagesRaw) ? pagesRaw : []).map((p: Record<string, unknown>) => ({
      id: Number(p.ID),
      title: String(p.post_title ?? ''),
      slug: String(p.post_name ?? ''),
      type: 'page' as const,
      parent: Number(p.post_parent ?? 0),
      url: `${siteUrl}/${String(p.post_name ?? '')}`,
      children: []
    }))

    // Build tree from flat list
    const nodeMap = new Map<number, WpSiteMapNode>()
    for (const node of pageNodes) nodeMap.set(node.id, node)

    const roots: WpSiteMapNode[] = []
    for (const node of pageNodes) {
      const parentNode = node.parent ? nodeMap.get(node.parent) : null
      if (parentNode) {
        parentNode.children.push(node)
      } else {
        roots.push(node)
      }
    }

    // Build post nodes (flat)
    const postNodes: WpSiteMapNode[] = (Array.isArray(postsRaw) ? postsRaw : []).map((p: Record<string, unknown>) => ({
      id: Number(p.ID),
      title: String(p.post_title ?? ''),
      slug: String(p.post_name ?? ''),
      type: 'post' as const,
      parent: 0,
      url: `${siteUrl}/${String(p.post_name ?? '')}`,
      children: []
    }))

    return { pages: roots, posts: postNodes, homePageId }
  } catch (e) {
    console.error('[wordpress] fetchSiteMap failed:', e instanceof Error ? e.message : e)
    return null
  }
}

export function getCachedSiteMap(path: string): WpSiteMap | null {
  const entry = siteMapCache.get(path)
  if (entry && isCacheFresh(entry)) return entry.siteMap
  return null
}

export function refreshSiteMap(path: string): Promise<WpSiteMap | null> {
  const existing = inflightSiteMapFetches.get(path)
  if (existing) return existing

  const promise = fetchSiteMap(path).then(siteMap => {
    if (siteMap) {
      siteMapCache.set(path, { siteMap, fetchedAt: Date.now() })
    } else {
      siteMapCache.delete(path)
    }
    inflightSiteMapFetches.delete(path)
    return siteMap
  }).catch(e => {
    console.error('[wordpress] refreshSiteMap failed:', e instanceof Error ? e.message : e)
    inflightSiteMapFetches.delete(path)
    return null
  })

  inflightSiteMapFetches.set(path, promise)
  return promise
}

// --- Theme JSON ---

async function fetchThemeJson(path: string): Promise<WpThemeJson | null> {
  const bin = findStudioBinary()
  if (!bin) return null

  try {
    // Get merged theme data (theme defaults + user customizations)
    let raw: string
    try {
      raw = await wpCliAsync(bin, path, [
        'eval', 'echo json_encode(WP_Theme_JSON_Resolver::get_merged_data()->get_raw_data());'
      ])
    } catch {
      // Fallback: read theme.json directly
      try {
        raw = await wpCliAsync(bin, path, [
          'eval', "echo file_get_contents(get_template_directory() . '/theme.json');"
        ])
      } catch {
        return null
      }
    }

    const data = JSON.parse(raw)
    if (!data) return null

    // Extract colors from settings.color.palette (can be at theme or default level)
    const palette = data.settings?.color?.palette
    const colors = extractArray(palette?.theme) || extractArray(palette?.custom) || extractArray(palette?.default) || []

    // Extract font families
    const fontFamiliesRaw = data.settings?.typography?.fontFamilies
    const fontFamilies = extractArray(fontFamiliesRaw?.theme) || extractArray(fontFamiliesRaw?.custom) || extractArray(fontFamiliesRaw?.default) || []

    // Extract font sizes
    const fontSizesRaw = data.settings?.typography?.fontSizes
    const fontSizes = extractArray(fontSizesRaw?.theme) || extractArray(fontSizesRaw?.custom) || extractArray(fontSizesRaw?.default) || []

    // Extract spacing sizes
    const spacingRaw = data.settings?.spacing?.spacingSizes
    const spacingSizes = extractArray(spacingRaw?.theme) || extractArray(spacingRaw?.custom) || extractArray(spacingRaw?.default) || []

    // Extract layout dimensions
    const contentWidth = data.settings?.layout?.contentSize || undefined
    const wideWidth = data.settings?.layout?.wideSize || undefined

    return {
      colors: colors.map((c: Record<string, unknown>) => ({
        slug: String(c.slug ?? ''),
        name: String(c.name ?? ''),
        color: String(c.color ?? '')
      })),
      fontFamilies: fontFamilies.map((f: Record<string, unknown>) => ({
        slug: String(f.slug ?? ''),
        name: String(f.name ?? ''),
        fontFamily: String(f.fontFamily ?? '')
      })),
      fontSizes: fontSizes.map((f: Record<string, unknown>) => ({
        slug: String(f.slug ?? ''),
        name: String(f.name ?? ''),
        size: String(f.size ?? '')
      })),
      spacingSizes: spacingSizes.map((s: Record<string, unknown>) => ({
        slug: String(s.slug ?? ''),
        name: String(s.name ?? ''),
        size: String(s.size ?? '')
      })),
      contentWidth,
      wideWidth
    }
  } catch (e) {
    console.error('[wordpress] fetchThemeJson failed:', e instanceof Error ? e.message : e)
    return null
  }
}

function extractArray(val: unknown): Record<string, unknown>[] | null {
  return Array.isArray(val) && val.length > 0 ? val : null
}

export function getCachedThemeJson(path: string): WpThemeJson | null {
  const entry = themeJsonCache.get(path)
  if (entry && isCacheFresh(entry)) return entry.themeJson
  return null
}

export function refreshThemeJson(path: string): Promise<WpThemeJson | null> {
  const existing = inflightThemeJsonFetches.get(path)
  if (existing) return existing

  const promise = fetchThemeJson(path).then(themeJson => {
    if (themeJson) {
      themeJsonCache.set(path, { themeJson, fetchedAt: Date.now() })
    } else {
      themeJsonCache.delete(path)
    }
    inflightThemeJsonFetches.delete(path)
    return themeJson
  }).catch(e => {
    console.error('[wordpress] refreshThemeJson failed:', e instanceof Error ? e.message : e)
    inflightThemeJsonFetches.delete(path)
    return null
  })

  inflightThemeJsonFetches.set(path, promise)
  return promise
}

// --- Sync site management (these are fast, single CLI calls) ---

export function listSites(): { available: boolean; sites: WordPressSite[] } {
  const bin = findStudioBinary()
  if (!bin) return { available: false, sites: [] }

  try {
    const raw = execFileSync(bin, ['site', 'list', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: SILENT_STDIO
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
      adminPassword: String(s.adminPassword ?? ''),
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
      timeout: 60_000,
      stdio: SILENT_STDIO
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
      timeout: 30_000,
      stdio: SILENT_STDIO
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
      timeout: 30_000,
      stdio: SILENT_STDIO
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
      timeout: 30_000,
      stdio: SILENT_STDIO
    })
  } catch (e) {
    console.error('[wordpress] stop failed:', e instanceof Error ? e.message : e)
  }

  invalidateDetails(path)
  return listSites()
}
