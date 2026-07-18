import { afterEach, describe, expect, it, vi } from 'vitest'
import { playTypewriter } from './typewriter'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('playTypewriter', () => {
  it('reveals monotonic word-boundary prefixes and finishes with the full text', async () => {
    vi.useFakeTimers()
    const text = 'Hi, I’m Bond.\n\nWhat should I call you?'
    const updates: string[] = []
    const done = playTypewriter(text, partial => updates.push(partial), 10)
    await vi.runAllTimersAsync()
    await done

    expect(updates.length).toBeGreaterThan(1)
    expect(updates.at(-1)).toBe(text)
    for (const [i, partial] of updates.entries()) {
      expect(text.startsWith(partial)).toBe(true)
      // Real streaming never breaks mid-word: every partial ends on a word
      // boundary (trailing whitespace run) or is the complete text.
      expect(partial === text || /\s$/.test(partial)).toBe(true)
      if (i > 0) expect(partial.length).toBeGreaterThan(updates[i - 1].length)
    }
  })

  it('catches up to wall-clock progress when timers are throttled', async () => {
    // Regression: Chromium clamps timers to ~1Hz while the window is occluded.
    // Fixed per-tick progress made the reveal crawl for minutes; anchoring to
    // elapsed time must complete the text as soon as a throttled tick lands.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const updates: string[] = []
    const done = playTypewriter('a long intro message', partial => updates.push(partial), 12)
    now = 5000 // window occluded: the first tick fires ~5s late
    await vi.runAllTimersAsync()
    await done

    expect(updates).toEqual(['a long intro message'])
  })

  it('emits nothing for empty text', async () => {
    const updates: string[] = []
    await playTypewriter('', partial => updates.push(partial), 1)
    expect(updates).toEqual([])
  })
})
