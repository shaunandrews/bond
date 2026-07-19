/**
 * Bond-owned Pi tools for web access: web_search and fetch_content.
 *
 * No API keys, no settings — searches run in the Bond app's hidden Chromium
 * window against DuckDuckGo, and page fetches ride the same window so
 * JS-heavy pages render fully before extraction. Results are cached briefly
 * and batch queries are spaced out to stay polite.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { renderPage as brokerRenderPage, type RenderedPage } from './broker'
import { DDG_RESULT_SELECTOR, ddgSearchUrl, extractReadable, parseDdgSerp } from './extract'

export const WEB_TOOL_NAMES = ['web_search', 'fetch_content']

export type RenderFn = (url: string, options?: { waitForSelector?: string; timeoutMs?: number }) => Promise<RenderedPage>

export interface WebToolOptions {
  /** Injection point for tests; defaults to the app render broker. */
  render?: RenderFn
  /** Politeness gap between consecutive engine hits in one batch. */
  searchDelayMs?: number
  cacheTtlMs?: number
}

const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 50
const SEARCH_DELAY_MS = 1_000
const MAX_BATCH = 5
const DEFAULT_NUM_RESULTS = 8
const DEFAULT_FETCH_CHARS = 20_000
const MAX_FETCH_CHARS = 50_000

interface CacheEntry {
  at: number
  value: unknown
}

const cache = new Map<string, CacheEntry>()

function cacheGet(key: string, ttlMs: number): unknown | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > ttlMs) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function clearWebCache(): void {
  cache.clear()
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function collectBatch(single: string | undefined, multiple: string[] | undefined, label: string): string[] {
  const items = [
    ...(single?.trim() ? [single.trim()] : []),
    ...(multiple ?? []).map(item => item.trim()).filter(Boolean),
  ]
  if (!items.length) throw new Error(`Provide ${label} to run this tool.`)
  return [...new Set(items)].slice(0, MAX_BATCH)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerWebTools(pi: ExtensionAPI, options: WebToolOptions = {}): void {
  const render = options.render ?? brokerRenderPage
  const searchDelayMs = options.searchDelayMs ?? SEARCH_DELAY_MS
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web. Supports batched queries for research — pass several queries at once and each returns structured results (title, url, snippet). Follow up with fetch_content to read promising pages.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Single search query' })),
      queries: Type.Optional(Type.Array(Type.String(), { description: 'Batch of search queries (max 5)' })),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Results per query (default 8)' })),
    }),
    async execute(_toolCallId, params) {
      const queries = collectBatch(params.query, params.queries, 'query or queries')
      const numResults = params.numResults ?? DEFAULT_NUM_RESULTS
      const searches: Array<Record<string, unknown>> = []

      for (const [index, query] of queries.entries()) {
        const cacheKey = `search:${numResults}:${query.toLowerCase()}`
        const cached = cacheGet(cacheKey, cacheTtlMs)
        if (cached) {
          searches.push({ query, results: cached, cached: true })
          continue
        }
        if (index > 0) await delay(searchDelayMs)
        try {
          const page = await render(ddgSearchUrl(query), { waitForSelector: DDG_RESULT_SELECTOR })
          const results = parseDdgSerp(page.html, numResults)
          if (results.length) {
            cacheSet(cacheKey, results)
            searches.push({ query, results })
          } else {
            searches.push({
              query,
              results,
              note: `No results parsed — the engine returned "${page.title || 'an unrecognized page'}". Try rephrasing, or fetch_content a known URL directly.`,
            })
          }
        } catch (err) {
          searches.push({ query, error: errorMessage(err) })
        }
      }
      return toolResult({ searches })
    },
  })

  pi.registerTool({
    name: 'fetch_content',
    label: 'Fetch Web Page',
    description: 'Fetch web page(s) in a real browser and return readable content as markdown. Handles JS-rendered pages. Use after web_search to read sources in depth.',
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: 'Single URL to fetch' })),
      urls: Type.Optional(Type.Array(Type.String(), { description: 'Batch of URLs to fetch (max 5)' })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_FETCH_CHARS, description: 'Character budget per page (default 20000)' })),
    }),
    async execute(_toolCallId, params) {
      const urls = collectBatch(params.url, params.urls, 'url or urls')
      const maxChars = params.maxChars ?? DEFAULT_FETCH_CHARS
      const pages: Array<Record<string, unknown>> = []

      for (const [index, url] of urls.entries()) {
        let parsed: URL
        try {
          parsed = new URL(url)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
        } catch {
          pages.push({ url, error: 'Only http(s) URLs can be fetched.' })
          continue
        }

        const cacheKey = `fetch:${parsed.href}`
        const cached = cacheGet(cacheKey, cacheTtlMs) as { title: string; markdown: string; finalUrl: string } | undefined
        if (cached) {
          pages.push({ url, ...cached, truncated: cached.markdown.length >= maxChars, cached: true })
          continue
        }
        if (index > 0) await delay(searchDelayMs)
        try {
          const page = await render(parsed.href)
          const readable = extractReadable(page.html, parsed.href)
          const full = { title: readable.title || page.title, markdown: readable.markdown, finalUrl: page.finalUrl || parsed.href }
          cacheSet(cacheKey, full)
          const truncated = full.markdown.length > maxChars
          pages.push({
            url,
            finalUrl: full.finalUrl,
            title: full.title,
            markdown: truncated ? `${full.markdown.slice(0, maxChars)}\n\n[truncated — ${full.markdown.length} chars total; refetch with a higher maxChars for more]` : full.markdown,
            truncated,
          })
        } catch (err) {
          pages.push({ url, error: errorMessage(err) })
        }
      }
      return toolResult({ pages })
    },
  })
}

export function createWebExtensionFactory(options: WebToolOptions = {}) {
  return (pi: ExtensionAPI) => registerWebTools(pi, options)
}
