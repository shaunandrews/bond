import { describe, it, expect } from 'vitest'
import { computeContentResize } from './window-layout'

const workArea = { x: 0, y: 23, width: 1920, height: 1057 }

describe('computeContentResize', () => {
  it('does nothing when the delta rounds to no change', () => {
    const current = { x: 100, y: 50, width: 1200, height: 800 }
    const result = computeContentResize(current, workArea, { deltaWidth: 0, minimumWidth: 400 })
    expect(result.bounds).toBeNull()
    expect(result.width).toBe(1200)
  })

  it('grows rightward, preserving the left edge, when there is room on the right', () => {
    const current = { x: 100, y: 50, width: 960, height: 720 }
    const result = computeContentResize(current, workArea, { deltaWidth: 320, minimumWidth: 680 })
    expect(result.bounds).toEqual({ x: 100, y: 50, width: 1280, height: 720 })
    expect(result.width).toBe(1280)
  })

  it('shrinks from the right edge, preserving the left edge (closing a panel)', () => {
    const current = { x: 100, y: 50, width: 1280, height: 720 }
    const result = computeContentResize(current, workArea, { deltaWidth: -320, minimumWidth: 400 })
    expect(result.bounds).toEqual({ x: 100, y: 50, width: 960, height: 720 })
    expect(result.width).toBe(960)
  })

  it('never shrinks below the minimum width', () => {
    const current = { x: 100, y: 50, width: 720, height: 720 }
    // Ask to shrink by 400 but the floor is 400 — stop there.
    const result = computeContentResize(current, workArea, { deltaWidth: -400, minimumWidth: 400 })
    expect(result.width).toBe(400)
  })

  it('expands left when growth would push past the right edge of the display', () => {
    const current = { x: 1800, y: 50, width: 100, height: 720 } // right edge at 1900
    const result = computeContentResize(current, workArea, { deltaWidth: 200, minimumWidth: 300 })
    // target 300; right edge would be 1800+300=2100 > 1920, so pull x left to 1620.
    expect(result.bounds).toEqual({ x: 1620, y: 50, width: 300, height: 720 })
  })

  it('clamps growth to the work area, never exceeding the display width', () => {
    const smallWorkArea = { x: 0, y: 23, width: 1000, height: 700 }
    const current = { x: 0, y: 23, width: 800, height: 600 }
    const result = computeContentResize(current, smallWorkArea, { deltaWidth: 400, minimumWidth: 400 })
    expect(result.bounds).toEqual({ x: 0, y: 23, width: 1000, height: 600 })
    expect(result.width).toBe(1000)
  })

  it('clamps a minimum wider than the display down to the work area (never forces off-screen)', () => {
    const smallWorkArea = { x: 0, y: 23, width: 900, height: 700 }
    const current = { x: 0, y: 23, width: 700, height: 600 }
    // Floor 980 exceeds the 900-wide display — treated as 900.
    const result = computeContentResize(current, smallWorkArea, { deltaWidth: 0, minimumWidth: 980 })
    expect(result.width).toBe(900)
  })

  // Multiple-display bounds — a window on a secondary display must never grow
  // across the seam into a neighbour's territory, in either direction.
  describe('multiple-display bounds', () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 800 }

    it('growing on a secondary display stops at that display\'s own right edge', () => {
      const current = { x: 1920, y: 50, width: 800, height: 600 }
      const result = computeContentResize(current, secondary, { deltaWidth: 380, minimumWidth: 400 })
      expect(result.bounds).toEqual({ x: 1920, y: 50, width: 1180, height: 600 })
      expect(result.bounds!.x).toBeGreaterThanOrEqual(secondary.x)
      expect(result.bounds!.x + result.bounds!.width).toBeLessThanOrEqual(secondary.x + secondary.width)
    })

    it('a window pinned far-right of a secondary display expands left without crossing into the primary', () => {
      const current = { x: 3120, y: 50, width: 80, height: 600 } // right edge at 3200
      const result = computeContentResize(current, secondary, { deltaWidth: 1100, minimumWidth: 400 })
      // target 1180; pulled left to 3200-1180=2020, never reaching x=1920.
      expect(result.bounds).toEqual({ x: 2020, y: 50, width: 1180, height: 600 })
      expect(result.bounds!.x).toBeGreaterThanOrEqual(secondary.x)
    })

    it('a secondary display too narrow for the target clamps to its own work area', () => {
      const current = { x: 1920, y: 0, width: 800, height: 800 }
      const result = computeContentResize(current, secondary, { deltaWidth: 640, minimumWidth: 400 })
      expect(result.bounds).toEqual({ x: 1920, y: 0, width: 1280, height: 800 })
      expect(result.width).toBe(1280)
    })
  })
})
