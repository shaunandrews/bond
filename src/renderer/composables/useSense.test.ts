import { describe, it, expect } from 'vitest'
import { appHue, appColor, isCaptureSearchRow } from './useSense'

describe('useSense pure functions', () => {
  describe('appHue', () => {
    it('returns a number between 0 and 359', () => {
      const hue = appHue('com.apple.Safari')
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    })

    it('is deterministic for same input', () => {
      const h1 = appHue('com.apple.Safari')
      const h2 = appHue('com.apple.Safari')
      expect(h1).toBe(h2)
    })

    it('produces different hues for different inputs', () => {
      const h1 = appHue('com.apple.Safari')
      const h2 = appHue('com.google.Chrome')
      // Theoretically they could collide, but extremely unlikely with these inputs
      expect(h1).not.toBe(h2)
    })

    it('handles empty string', () => {
      const hue = appHue('')
      expect(hue).toBe(0)
    })
  })

  describe('isCaptureSearchRow', () => {
    it('accepts snake_case capture rows', () => {
      expect(isCaptureSearchRow({ id: 'capture-1', captured_at: '2026-07-17T12:00:00Z' })).toBe(true)
    })

    it('accepts camelCase capture rows', () => {
      expect(isCaptureSearchRow({ id: 'capture-1', capturedAt: '2026-07-17T12:00:00Z' })).toBe(true)
    })

    it('rejects debrief and fact rows', () => {
      expect(isCaptureSearchRow({ id: 'memory-1', createdAt: '2026-07-17T12:00:00Z', channel: 'chat' })).toBe(false)
    })
  })

  describe('appColor', () => {
    it('returns HSL string for light mode', () => {
      const color = appColor('com.apple.Safari', false)
      expect(color).toMatch(/^hsl\(\d+, 55%, 50%\)$/)
    })

    it('returns HSL string for dark mode', () => {
      const color = appColor('com.apple.Safari', true)
      expect(color).toMatch(/^hsl\(\d+, 50%, 65%\)$/)
    })

    it('defaults to light mode', () => {
      const color = appColor('com.apple.Safari')
      expect(color).toContain('55%')
    })
  })
})
