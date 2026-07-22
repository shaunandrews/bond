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
})
