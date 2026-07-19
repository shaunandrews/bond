/**
 * HTML extraction for web tools.
 *
 * Both functions operate on already-rendered HTML delivered by the app's
 * hidden browser window, so all parsing logic lives in the daemon where it is
 * unit-testable against fixture HTML.
 */

import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

export interface SearchResultItem {
  title: string
  url: string
  snippet: string
}

export interface ReadablePage {
  title: string
  markdown: string
}

/** Result rows on the rendered DuckDuckGo SERP, oldest markup variants last. */
export const DDG_RESULT_SELECTOR = '[data-testid="result"], article[data-nrn], .result'

export function ddgSearchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`
}

/** Parse a rendered DuckDuckGo SERP into structured results. */
export function parseDdgSerp(html: string, limit = 8): SearchResultItem[] {
  const { document } = parseHTML(html)
  const rows = Array.from(document.querySelectorAll(DDG_RESULT_SELECTOR))
  const results: SearchResultItem[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    if (results.length >= limit) break
    if (isAdRow(row)) continue

    const heading = row.querySelector('h2, h3')
    const anchor = row.querySelector('a[href]')
    const rawHref = (heading?.querySelector('a[href]') ?? anchor)?.getAttribute('href') ?? ''
    const url = resolveResultUrl(rawHref)
    if (!url || seen.has(url)) continue

    const title = textOf(heading) || textOf(anchor)
    if (!title) continue

    const snippet = textOf(row.querySelector('[data-result="snippet"], [data-testid="result-snippet"], .result__snippet'))
    seen.add(url)
    results.push({ title, url, snippet: snippet.slice(0, 300) })
  }
  return results
}

function isAdRow(row: Element): boolean {
  if ((row.getAttribute('data-layout') ?? '').toLowerCase() === 'ad') return true
  const href = row.querySelector('a[href]')?.getAttribute('href') ?? ''
  return href.includes('duckduckgo.com/y.js')
}

/**
 * Result hrefs are usually direct, but DDG's fallback markup routes them
 * through an uddg redirect parameter — unwrap to the real destination.
 */
function resolveResultUrl(href: string): string | null {
  if (!href) return null
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    if (url.hostname.endsWith('duckduckgo.com')) {
      const uddg = url.searchParams.get('uddg')
      if (!uddg) return null
      return resolveResultUrl(uddg)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

/** Reduce a rendered page to readable markdown via Readability + Turndown. */
export function extractReadable(html: string, url: string): ReadablePage {
  const { document } = parseHTML(html)
  let title = textOf(document.querySelector('title'))

  let contentHtml: string | null = null
  try {
    const article = new Readability(document as unknown as Document, { charThreshold: 100 }).parse()
    if (article?.content) {
      contentHtml = article.content
      title = article.title?.trim() || title
    }
  } catch {
    // Readability gives up on some layouts — fall through to the plain-text path.
  }

  if (contentHtml) {
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    turndown.remove(['script', 'style'])
    return { title, markdown: turndown.turndown(contentHtml).trim() }
  }

  // Fallback: strip chrome and return the body text so the agent still gets
  // something useful from pages Readability can't model.
  const { document: doc } = parseHTML(html)
  for (const el of Array.from(doc.querySelectorAll('script, style, noscript, nav, header, footer, iframe'))) {
    el.remove()
  }
  const text = (doc.body?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { title: title || url, markdown: text }
}
