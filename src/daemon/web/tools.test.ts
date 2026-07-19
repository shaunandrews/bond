import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WEB_TOOL_NAMES, clearWebCache, createWebExtensionFactory, registerWebTools } from './tools'
import type { RenderedPage } from './broker'

interface RegisteredToolDef {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: any }>
}

function collectTools(options: Parameters<typeof registerWebTools>[1] = {}): Map<string, RegisteredToolDef> {
  const tools = new Map<string, RegisteredToolDef>()
  const pi = { registerTool: (def: RegisteredToolDef) => tools.set(def.name, def) }
  registerWebTools(pi as any, { searchDelayMs: 0, ...options })
  return tools
}

function serpPage(): RenderedPage {
  return {
    html: `<article data-testid="result" data-layout="organic">
      <h2><a href="https://example.com/one">Result One</a></h2>
      <div data-result="snippet">First snippet.</div>
    </article>
    <article data-testid="result" data-layout="organic">
      <h2><a href="https://example.com/two">Result Two</a></h2>
      <div data-result="snippet">Second snippet.</div>
    </article>`,
    finalUrl: 'https://duckduckgo.com/?q=x',
    title: 'x at DuckDuckGo',
  }
}

function articlePage(bodyChars = 600): RenderedPage {
  const text = 'Content sentence for the fetched article, long enough for Readability. '.repeat(Math.ceil(bodyChars / 70))
  return {
    html: `<html><head><title>Fetched Article</title></head><body><article><h1>Fetched Article</h1><p>${text}</p></article></body></html>`,
    finalUrl: 'https://example.com/article/',
    title: 'Fetched Article',
  }
}

beforeEach(() => {
  clearWebCache()
})

describe('registerWebTools', () => {
  it('registers exactly the exported tool names', () => {
    const tools = collectTools({ render: vi.fn() })
    expect([...tools.keys()].sort()).toEqual([...WEB_TOOL_NAMES].sort())
  })

  it('createWebExtensionFactory registers the same tools', () => {
    const names: string[] = []
    createWebExtensionFactory()({ registerTool: (def: any) => names.push(def.name) } as any)
    expect(names.sort()).toEqual([...WEB_TOOL_NAMES].sort())
  })
})

describe('web_search', () => {
  it('renders the DDG SERP and returns parsed results', async () => {
    const render = vi.fn().mockResolvedValue(serpPage())
    const tool = collectTools({ render }).get('web_search')!

    const { details } = await tool.execute('call-1', { query: 'vue composables' })
    expect(render).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=vue%20composables&ia=web',
      expect.objectContaining({ waitForSelector: expect.stringContaining('result') }),
    )
    expect(details.searches).toHaveLength(1)
    expect(details.searches[0].results).toEqual([
      { title: 'Result One', url: 'https://example.com/one', snippet: 'First snippet.' },
      { title: 'Result Two', url: 'https://example.com/two', snippet: 'Second snippet.' },
    ])
  })

  it('runs batched queries and dedupes repeats', async () => {
    const render = vi.fn().mockResolvedValue(serpPage())
    const tool = collectTools({ render }).get('web_search')!

    const { details } = await tool.execute('call-1', { queries: ['alpha', 'beta', 'alpha'] })
    expect(render).toHaveBeenCalledTimes(2)
    expect(details.searches.map((s: any) => s.query)).toEqual(['alpha', 'beta'])
  })

  it('serves repeat queries from cache without re-rendering', async () => {
    const render = vi.fn().mockResolvedValue(serpPage())
    const tool = collectTools({ render }).get('web_search')!

    await tool.execute('call-1', { query: 'cached topic' })
    const { details } = await tool.execute('call-2', { query: 'Cached Topic' })
    expect(render).toHaveBeenCalledTimes(1)
    expect(details.searches[0].cached).toBe(true)
  })

  it('reports per-query errors without failing the batch', async () => {
    const render = vi.fn()
      .mockRejectedValueOnce(new Error('app not running'))
      .mockResolvedValueOnce(serpPage())
    const tool = collectTools({ render }).get('web_search')!

    const { details } = await tool.execute('call-1', { queries: ['broken', 'works'] })
    expect(details.searches[0].error).toContain('app not running')
    expect(details.searches[1].results).toHaveLength(2)
  })

  it('adds a diagnostic note when no results parse', async () => {
    const render = vi.fn().mockResolvedValue({ html: '<html><body>Checking your browser…</body></html>', finalUrl: 'x', title: 'Anomaly check' })
    const tool = collectTools({ render }).get('web_search')!

    const { details } = await tool.execute('call-1', { query: 'anything' })
    expect(details.searches[0].results).toEqual([])
    expect(details.searches[0].note).toContain('Anomaly check')
  })

  it('rejects a call with no queries', async () => {
    const tool = collectTools({ render: vi.fn() }).get('web_search')!
    await expect(tool.execute('call-1', {})).rejects.toThrow(/query/)
  })
})

describe('fetch_content', () => {
  it('fetches a page and returns readable markdown', async () => {
    const render = vi.fn().mockResolvedValue(articlePage())
    const tool = collectTools({ render }).get('fetch_content')!

    const { details } = await tool.execute('call-1', { url: 'https://example.com/article' })
    expect(details.pages).toHaveLength(1)
    expect(details.pages[0].title).toBe('Fetched Article')
    expect(details.pages[0].finalUrl).toBe('https://example.com/article/')
    expect(details.pages[0].markdown).toContain('Content sentence for the fetched article')
    expect(details.pages[0].truncated).toBe(false)
  })

  it('truncates long pages to the character budget with a note', async () => {
    const render = vi.fn().mockResolvedValue(articlePage(4000))
    const tool = collectTools({ render }).get('fetch_content')!

    const { details } = await tool.execute('call-1', { url: 'https://example.com/article', maxChars: 1000 })
    expect(details.pages[0].truncated).toBe(true)
    expect(details.pages[0].markdown).toContain('[truncated')
    expect(details.pages[0].markdown.length).toBeLessThan(1200)
  })

  it('rejects non-http URLs per item without failing the batch', async () => {
    const render = vi.fn().mockResolvedValue(articlePage())
    const tool = collectTools({ render }).get('fetch_content')!

    const { details } = await tool.execute('call-1', { urls: ['file:///etc/passwd', 'https://example.com/ok'] })
    expect(details.pages[0].error).toContain('http(s)')
    expect(details.pages[1].markdown).toBeDefined()
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('serves repeat fetches from cache', async () => {
    const render = vi.fn().mockResolvedValue(articlePage())
    const tool = collectTools({ render }).get('fetch_content')!

    await tool.execute('call-1', { url: 'https://example.com/article' })
    const { details } = await tool.execute('call-2', { url: 'https://example.com/article' })
    expect(render).toHaveBeenCalledTimes(1)
    expect(details.pages[0].cached).toBe(true)
  })
})
