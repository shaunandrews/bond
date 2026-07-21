import { describe, it, expect } from 'vitest'
import { clampHotRects } from './desk-window'

/** The 16" measurements: 640×240 window, 185pt notch, 33pt menu bar. */
const BOUNDS = { width: 640, height: 240 }
const NOTCH = { menuBarHeight: 33, restWidth: 185 }
const notchLeft = BOUNDS.width / 2 - NOTCH.restWidth / 2   // 227.5
const notchRight = BOUNDS.width / 2 + NOTCH.restWidth / 2  // 412.5

/** The one invariant that matters: nothing interactive over the menu bar. */
function violatesMenuBar(rects: ReturnType<typeof clampHotRects>): boolean {
  return rects.some(r =>
    r.y < NOTCH.menuBarHeight && (r.x < notchLeft - 0.001 || r.x + r.width > notchRight + 0.001)
  )
}

describe('clampHotRects — the menu bar invariant', () => {
  it('keeps a rect that stays inside the notch x-range above the bar', () => {
    const out = clampHotRects([{ x: 227.5, y: 0, width: 185, height: 32 }], BOUNDS, NOTCH)
    expect(out).toEqual([{ x: 227.5, y: 0, width: 185, height: 32 }])
    expect(violatesMenuBar(out)).toBe(false)
  })

  it('clips a full-width rect down to the notch above the bar', () => {
    // A renderer bug proposing the whole window width must not break the menu bar
    const out = clampHotRects([{ x: 0, y: 0, width: 640, height: 20 }], BOUNDS, NOTCH)
    expect(violatesMenuBar(out)).toBe(false)
    expect(out).toEqual([{ x: notchLeft, y: 0, width: 185, height: 20 }])
  })

  it('splits a rect that straddles the menu bar into a clipped top and a free bottom', () => {
    const out = clampHotRects([{ x: 0, y: 0, width: 640, height: 100 }], BOUNDS, NOTCH)
    expect(violatesMenuBar(out)).toBe(false)

    const above = out.filter(r => r.y < NOTCH.menuBarHeight)
    const below = out.filter(r => r.y >= NOTCH.menuBarHeight)
    expect(above).toEqual([{ x: notchLeft, y: 0, width: 185, height: 33 }])
    expect(below).toEqual([{ x: 0, y: 33, width: 640, height: 67 }])
  })

  it('leaves a rect entirely below the bar untouched', () => {
    const rect = { x: 140, y: 33, width: 360, height: 44 }
    expect(clampHotRects([rect], BOUNDS, NOTCH)).toEqual([rect])
  })

  it('drops a rect that lies entirely outside the notch above the bar', () => {
    const out = clampHotRects([{ x: 0, y: 0, width: 100, height: 20 }], BOUNDS, NOTCH)
    expect(out).toEqual([])
  })

  it('clips a rect extending past the window edges', () => {
    const out = clampHotRects([{ x: -200, y: 100, width: 2000, height: 500 }], BOUNDS, NOTCH)
    expect(out).toEqual([{ x: 0, y: 100, width: 640, height: 140 }])
  })

  it('drops degenerate and inverted rects', () => {
    expect(clampHotRects([{ x: 10, y: 10, width: 0, height: 10 }], BOUNDS, NOTCH)).toEqual([])
    expect(clampHotRects([{ x: 10, y: 10, width: 10, height: 0 }], BOUNDS, NOTCH)).toEqual([])
    expect(clampHotRects([{ x: 700, y: 300, width: 50, height: 50 }], BOUNDS, NOTCH)).toEqual([])
  })

  it('handles an empty proposal', () => {
    expect(clampHotRects([], BOUNDS, NOTCH)).toEqual([])
  })

  it('never violates the invariant for any proposal, however hostile', () => {
    const hostile = [
      { x: 0, y: 0, width: 640, height: 240 },
      { x: -1000, y: -1000, width: 5000, height: 5000 },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 300, y: 0, width: 340, height: 10 },
      { x: 0, y: 32, width: 640, height: 2 },
      { x: 226, y: 0, width: 188, height: 33 },
    ]
    for (const rect of hostile) {
      expect(violatesMenuBar(clampHotRects([rect], BOUNDS, NOTCH))).toBe(false)
    }
    expect(violatesMenuBar(clampHotRects(hostile, BOUNDS, NOTCH))).toBe(false)
  })

  it('on a display with no menu bar of its own, nothing is restricted', () => {
    // A secondary display with "Displays have separate Spaces" off reports 0.
    const out = clampHotRects([{ x: 0, y: 0, width: 640, height: 100 }], BOUNDS, {
      menuBarHeight: 0, restWidth: 300,
    })
    expect(out).toEqual([{ x: 0, y: 0, width: 640, height: 100 }])
  })
})
