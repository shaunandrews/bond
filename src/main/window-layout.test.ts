import { describe, it, expect } from 'vitest'
import { computeEnsuredContentWidth } from './window-layout'

const workArea = { x: 0, y: 23, width: 1920, height: 1057 }

describe('computeEnsuredContentWidth', () => {
  it('does nothing when the window already meets the preferred width', () => {
    const current = { x: 100, y: 50, width: 1200, height: 800 }
    const result = computeEnsuredContentWidth(current, workArea, { preferredWidth: 1180, minimumWidth: 1096 })
    expect(result.bounds).toBeNull()
    expect(result.width).toBe(1200)
    expect(result.reachedPreferred).toBe(true)
  })

  it('grows rightward, preserving the left edge, when there is room on the right', () => {
    const current = { x: 100, y: 50, width: 960, height: 720 }
    const result = computeEnsuredContentWidth(current, workArea, { preferredWidth: 1180, minimumWidth: 1096 })
    expect(result.bounds).toEqual({ x: 100, y: 50, width: 1180, height: 720 })
    expect(result.reachedPreferred).toBe(true)
  })

  it('expands left when there is not enough room on the right', () => {
    // Window sits near the right edge of a 1920-wide work area.
    const current = { x: 1800, y: 50, width: 960, height: 720 }
    const result = computeEnsuredContentWidth(current, workArea, { preferredWidth: 1180, minimumWidth: 1096 })
    // rightSpace = 1920 - 1800 = 120, short of 1180 by 1060 — pull the left edge back by that much.
    expect(result.bounds).toEqual({ x: 740, y: 50, width: 1180, height: 720 })
    expect(result.reachedPreferred).toBe(true)
  })

  it('clamps to the work area and reports reachedPreferred=false on a display too small to fit', () => {
    const smallWorkArea = { x: 0, y: 23, width: 1000, height: 700 }
    const current = { x: 0, y: 23, width: 800, height: 600 }
    const result = computeEnsuredContentWidth(current, smallWorkArea, { preferredWidth: 1180, minimumWidth: 1096 })
    expect(result.bounds).toEqual({ x: 0, y: 23, width: 1000, height: 600 })
    expect(result.reachedPreferred).toBe(false)
  })

  it('never moves left of the work area origin', () => {
    const current = { x: 10, y: 50, width: 960, height: 720 }
    const result = computeEnsuredContentWidth(current, workArea, { preferredWidth: 1180, minimumWidth: 1096 })
    // rightSpace = 1920 - 10 = 1910, plenty — grows rightward only.
    expect(result.bounds).toEqual({ x: 10, y: 50, width: 1180, height: 720 })
  })

  it('clamps growth against a work area that does not start at x=0', () => {
    const offsetWorkArea = { x: 1920, y: 0, width: 1440, height: 900 }
    const current = { x: 1920, y: 100, width: 800, height: 600 }
    const result = computeEnsuredContentWidth(current, offsetWorkArea, { preferredWidth: 1180, minimumWidth: 1096 })
    expect(result.bounds).toEqual({ x: 1920, y: 100, width: 1180, height: 600 })
    expect(result.reachedPreferred).toBe(true)
  })

  // plans/chat-threads.md Phase 6 item 6 — multiple-display bounds: a window
  // living on a secondary display must never grow across the seam into its
  // neighbor's territory, in either direction.
  describe('multiple-display bounds', () => {
    const primary = { x: 0, y: 23, width: 1920, height: 1057 }
    const secondary = { x: 1920, y: 0, width: 1280, height: 800 }

    it('growing rightward on a secondary display stops at that display\'s own right edge, not the primary\'s', () => {
      const current = { x: 1920, y: 50, width: 800, height: 600 }
      const result = computeEnsuredContentWidth(current, secondary, { preferredWidth: 1180, minimumWidth: 1096 })
      expect(result.bounds).toEqual({ x: 1920, y: 50, width: 1180, height: 600 })
      // Right edge of the new bounds (1920 + 1180 = 3100) stays inside the
      // secondary display (1920..3200) and never dips back into the primary.
      expect(result.bounds!.x).toBeGreaterThanOrEqual(secondary.x)
      expect(result.bounds!.x + result.bounds!.width).toBeLessThanOrEqual(secondary.x + secondary.width)
    })

    it('a window pinned to the far right of a secondary display expands left without crossing into the primary display\'s x-range', () => {
      const current = { x: 3120, y: 50, width: 800, height: 600 } // right edge at 3200, the secondary's own edge
      const result = computeEnsuredContentWidth(current, secondary, { preferredWidth: 1180, minimumWidth: 1096 })
      // rightSpace = (1920+1280) - 3120 = 80, short of 1180 by 1100 — pulled left by that overflow (3120-1100=2020),
      // landing right at the display's own right edge (2020+1180=3200) without ever reaching back to x=1920.
      expect(result.bounds).toEqual({ x: 2020, y: 50, width: 1180, height: 600 })
      expect(result.bounds!.x).toBeGreaterThanOrEqual(secondary.x)
    })

    it('a secondary display too narrow for the preferred width clamps to its own work area, never borrowing width from the primary', () => {
      const current = { x: 1920, y: 0, width: 800, height: 800 }
      const result = computeEnsuredContentWidth(current, secondary, { preferredWidth: 1440, minimumWidth: 1096 })
      expect(result.bounds).toEqual({ x: 1920, y: 0, width: 1280, height: 800 })
      expect(result.reachedPreferred).toBe(false)
    })

    it('the primary display\'s own growth is unaffected by an adjacent secondary display existing', () => {
      const current = { x: 100, y: 50, width: 960, height: 720 }
      const result = computeEnsuredContentWidth(current, primary, { preferredWidth: 1180, minimumWidth: 1096 })
      expect(result.bounds).toEqual({ x: 100, y: 50, width: 1180, height: 720 })
    })
  })
})
