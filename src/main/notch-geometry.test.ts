import { describe, it, expect } from 'vitest'
import { fallbackGeometry, menuBarHeightFor, restShape } from './notch-geometry'
import type { Display } from 'electron'

/** A 16" MacBook Pro at default scaling — the machine the plan was measured on. */
function display(over: Partial<Display> = {}): Display {
  return {
    id: 1,
    bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    workArea: { x: 0, y: 33, width: 1728, height: 1084 },
    internal: true,
    scaleFactor: 2,
    ...over,
  } as Display
}

describe('menuBarHeightFor', () => {
  it('uses workArea.y - bounds.y', () => {
    expect(menuBarHeightFor(display())).toBe(33)
  })

  it('is not fooled by a Dock at the bottom', () => {
    // `bounds.height - workArea.height` would return 33 + dock here.
    const withDock = display({
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      workArea: { x: 0, y: 33, width: 1728, height: 984 }, // 100pt Dock at the bottom
    } as Partial<Display>)
    expect(menuBarHeightFor(withDock)).toBe(33)
  })

  it('returns 0 on a display with no menu bar of its own', () => {
    const secondary = display({
      id: 2,
      bounds: { x: 1728, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1728, y: 0, width: 1920, height: 1080 },
      internal: false,
    } as Partial<Display>)
    expect(menuBarHeightFor(secondary)).toBe(0)
  })

  it('never goes negative', () => {
    const odd = display({
      bounds: { x: 0, y: 100, width: 100, height: 100 },
      workArea: { x: 0, y: 0, width: 100, height: 100 },
    } as Partial<Display>)
    expect(menuBarHeightFor(odd)).toBe(0)
  })
})

describe('fallbackGeometry', () => {
  it('reproduces the measured 16" notch within a point', () => {
    const geometry = fallbackGeometry(display())
    expect(geometry.notched).toBe(true)
    expect(geometry.notchWidth).toBe(185)   // the measured value
    expect(geometry.notchHeight).toBe(32)   // menu bar height - 1
    expect(geometry.measured).toBe(false)   // and it says it is a guess
  })

  it('scales with framebuffer width rather than hardcoding a table', () => {
    // The notch is a fixed number of PHYSICAL pixels; point size scales.
    const moreSpace = fallbackGeometry(display({
      bounds: { x: 0, y: 0, width: 2056, height: 1329 },
      workArea: { x: 0, y: 38, width: 2056, height: 1291 },
    } as Partial<Display>))
    expect(moreSpace.notchWidth).toBeGreaterThan(185)
    expect(moreSpace.notchWidth).toBe(Math.round(185 * (2056 / 1728)))
  })

  it('reports not-notched for an external display', () => {
    const external = fallbackGeometry(display({
      id: 2,
      internal: false,
      bounds: { x: 1728, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1728, y: 25, width: 1920, height: 1055 },
    } as Partial<Display>))
    expect(external.notched).toBe(false)
    expect(external.notchWidth).toBe(0)
  })

  it('reports not-notched for an internal display with too short a menu bar', () => {
    const old = fallbackGeometry(display({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 },
    } as Partial<Display>))
    expect(old.notched).toBe(false)
  })
})

describe('restShape', () => {
  it('takes the notch width, and enough height to clear the menu bar', () => {
    // Height must extend PAST the bar: anything drawn inside the notch's own
    // footprint is physically invisible, however good it looks in a screenshot.
    const shape = restShape(fallbackGeometry(display()))
    expect(shape.width).toBe(185)
    expect(shape.height).toBeGreaterThan(33)
  })

  it('always leaves room below the menu bar for the hairline', () => {
    for (const menuBarHeight of [0, 24, 25, 33, 38]) {
      const shape = restShape({
        displayId: 1, notched: true, notchWidth: 185, notchHeight: menuBarHeight - 1,
        menuBarHeight, measured: true,
      })
      expect(shape.height).toBeGreaterThan(menuBarHeight)
    }
  })

  it('falls back to DynamicNotchKit’s 300pt lozenge width elsewhere', () => {
    const shape = restShape({
      displayId: 2, notched: false, notchWidth: 0, notchHeight: 0,
      menuBarHeight: 25, measured: true,
    })
    expect(shape.width).toBe(300)
    expect(shape.height).toBeGreaterThan(25)
  })

  it('keeps a usable height on a display reporting no menu bar', () => {
    const shape = restShape({
      displayId: 3, notched: false, notchWidth: 0, notchHeight: 0,
      menuBarHeight: 0, measured: true,
    })
    expect(shape.height).toBeGreaterThan(0)
  })
})
