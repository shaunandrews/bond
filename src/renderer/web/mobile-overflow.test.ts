import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The mobile web client must never scroll horizontally. These are CSS
 * invariants — happy-dom does no layout and @vue/test-utils never injects
 * scoped styles, so the rules are asserted against the stylesheet source.
 * That is exactly the level the bug lived at: `.messages` declared only
 * `overflow-y: auto`, which computes `overflow-x` to `auto` rather than
 * `visible`, so one over-wide message turned the whole transcript into a
 * sideways swipe surface.
 */

function source(relative: string): string {
  return readFileSync(resolve(__dirname, relative), 'utf8')
}

/** The declarations of a single CSS rule, by selector, from an SFC's styles. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  expect(match, `expected a \`${selector}\` rule to exist`).toBeTruthy()
  return match![2]
}

describe('mobile transcript overflow containment', () => {
  const webApp = source('./WebApp.vue')
  const markdown = source('../components/MarkdownMessage.vue')
  const bubble = source('../components/MessageBubble.vue')

  it('pins the transcript to a single scroll axis', () => {
    expect(rule(webApp, '.messages')).toMatch(/overflow-x:\s*hidden/)
  })

  it('gives the app shell no scroll box at all', () => {
    // `hidden` would still be a scroll container: focusing a field near the
    // edge lets the browser scroll the shell sideways on its own.
    expect(rule(webApp, '.web-app')).toMatch(/overflow:\s*clip/)
  })

  it('breaks unbreakable tokens in both message registers', () => {
    expect(rule(markdown, '.bond-message')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule(bubble, '.user-markdown')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('scrolls wide markdown tables inside their own box', () => {
    const table = rule(markdown, '.bond-message table')
    expect(table).toMatch(/max-width:\s*100%/)
    expect(table).toMatch(/overflow-x:\s*auto/)
  })

  it('caps generated images at the column width', () => {
    // A bare `max-w-[420px]` overflows a phone-width column.
    expect(bubble).not.toMatch(/max-w-\[\d+px\]\s+max-h-\[420px\]/)
    expect(bubble).toMatch(/max-w-\[min\(100%,\s*420px\)\]/)
  })
})
