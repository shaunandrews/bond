import { describe, expect, it } from 'vitest'
import { ddgSearchUrl, extractReadable, parseDdgSerp } from './extract'

function serpFixture(): string {
  return `<!doctype html><html><head><title>results — DuckDuckGo</title></head><body>
    <article data-testid="result" data-layout="ad">
      <h2><a href="https://duckduckgo.com/y.js?ad_domain=ads.example">Sponsored thing</a></h2>
      <div data-result="snippet">Buy now</div>
    </article>
    <article data-testid="result" data-layout="organic">
      <h2><a href="https://vuejs.org/guide/reusability/composables.html">Composables — Vue.js</a></h2>
      <div data-result="snippet">Official guide to   composables in Vue 3.</div>
    </article>
    <article data-testid="result" data-layout="organic">
      <h2><a href="https://vuejs.org/guide/reusability/composables.html">Composables — Vue.js (dupe)</a></h2>
      <div data-result="snippet">Duplicate URL should be skipped.</div>
    </article>
    <article data-testid="result" data-layout="organic">
      <h2><a href="javascript:void(0)">Bogus protocol</a></h2>
    </article>
    <article data-testid="result" data-layout="organic">
      <h2><a href="https://alexop.dev/posts/mastering-vue-3-composables/">Mastering Vue 3 Composables</a></h2>
      <div data-result="snippet">A comprehensive style guide.</div>
    </article>
  </body></html>`
}

describe('parseDdgSerp', () => {
  it('parses organic rows, filters ads and bad protocols, and dedupes URLs', () => {
    const results = parseDdgSerp(serpFixture())
    expect(results).toEqual([
      {
        title: 'Composables — Vue.js',
        url: 'https://vuejs.org/guide/reusability/composables.html',
        snippet: 'Official guide to composables in Vue 3.',
      },
      {
        title: 'Mastering Vue 3 Composables',
        url: 'https://alexop.dev/posts/mastering-vue-3-composables/',
        snippet: 'A comprehensive style guide.',
      },
    ])
  })

  it('respects the result limit', () => {
    expect(parseDdgSerp(serpFixture(), 1)).toHaveLength(1)
  })

  it('unwraps legacy uddg redirect links', () => {
    const html = `<div class="result">
      <h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost%3Fa%3D1&rut=abc">Example Post</a></h2>
      <a class="result__snippet">Legacy markup snippet.</a>
    </div>`
    expect(parseDdgSerp(html)).toEqual([
      { title: 'Example Post', url: 'https://example.com/post?a=1', snippet: 'Legacy markup snippet.' },
    ])
  })

  it('returns empty for a page with no result rows (e.g. a challenge page)', () => {
    expect(parseDdgSerp('<html><body><p>Checking your browser…</p></body></html>')).toEqual([])
  })
})

describe('ddgSearchUrl', () => {
  it('encodes the query', () => {
    expect(ddgSearchUrl('vue 3 & "composables"')).toBe('https://duckduckgo.com/?q=vue%203%20%26%20%22composables%22&ia=web')
  })
})

describe('extractReadable', () => {
  it('extracts article content as markdown with headings and links', () => {
    const paragraph = 'Composables are functions that leverage the Composition API to encapsulate and reuse stateful logic across components. '.repeat(4)
    const html = `<!doctype html><html><head><title>Composables Guide</title></head><body>
      <nav>Home / Docs / Guide</nav>
      <article>
        <h1>Composables</h1>
        <p>${paragraph}</p>
        <p>Read the <a href="https://vuejs.org/api/">API reference</a> for details. ${paragraph}</p>
      </article>
      <footer>© Vue</footer>
    </body></html>`

    const page = extractReadable(html, 'https://vuejs.org/guide')
    expect(page.title).toContain('Composables')
    expect(page.markdown).toContain('Composables are functions')
    expect(page.markdown).toContain('[API reference](https://vuejs.org/api/)')
    expect(page.markdown).not.toContain('<p>')
  })

  it('falls back to body text when Readability finds no article', () => {
    const html = '<html><head><title>Tiny</title><style>.x{}</style></head><body><script>var x=1</script><div>Just a stub.</div></body></html>'
    const page = extractReadable(html, 'https://example.com/stub')
    expect(page.title).toBe('Tiny')
    expect(page.markdown).toContain('Just a stub.')
    expect(page.markdown).not.toContain('var x=1')
  })
})
