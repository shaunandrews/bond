import { describe, it, expect, vi } from 'vitest'
import { coversDisplay, createFullscreenWatcher, isFullscreen } from './desk-fullscreen'
import type { DetectedWindow } from '../shared/sense'

/** The 16" measurements: 1728×1117 frame, 33pt menu bar. */
const DISPLAY = { x: 0, y: 0, width: 1728, height: 1117 }
const SECOND = { x: 1728, y: 0, width: 1920, height: 1080 }

function win(over: Partial<DetectedWindow> = {}): DetectedWindow {
  return {
    name: 'Figma', bundleId: 'com.figma.Desktop', title: 'Studio Workbench',
    active: true, pid: 1, layer: 0,
    frame: { x: 0, y: 33, width: 1728, height: 1084 },
    ...over,
  }
}

describe('coversDisplay', () => {
  it('true for a window covering the whole display including the menu bar strip', () => {
    expect(coversDisplay({ x: 0, y: 0, width: 1728, height: 1117 }, DISPLAY)).toBe(true)
  })

  it('false for a maximised window that stops below the menu bar', () => {
    // This is the whole discriminator — an ordinary maximised window starts at y=33.
    expect(coversDisplay({ x: 0, y: 33, width: 1728, height: 1084 }, DISPLAY)).toBe(false)
  })

  it('tolerates a point or two of rounding slack', () => {
    expect(coversDisplay({ x: 0, y: 1, width: 1727, height: 1116 }, DISPLAY)).toBe(true)
  })

  it('false for a window that is merely large', () => {
    expect(coversDisplay({ x: 100, y: 100, width: 1400, height: 900 }, DISPLAY)).toBe(false)
  })

  it('false for a full-width window that is not full-height', () => {
    expect(coversDisplay({ x: 0, y: 0, width: 1728, height: 400 }, DISPLAY)).toBe(false)
  })
})

describe('isFullscreen', () => {
  it('detects a fullscreen window on the primary display', () => {
    const active = win({ frame: { x: 0, y: 0, width: 1728, height: 1117 } })
    expect(isFullscreen([active], [DISPLAY, SECOND])).toBe(true)
  })

  it('detects a fullscreen window on a secondary display', () => {
    const active = win({ frame: { x: 1728, y: 0, width: 1920, height: 1080 } })
    expect(isFullscreen([active], [DISPLAY, SECOND])).toBe(true)
  })

  it('false for a normal maximised window — the common false positive', () => {
    expect(isFullscreen([win()], [DISPLAY])).toBe(false)
  })

  it('ignores background windows and judges only the active one', () => {
    const background = win({ active: false, frame: { x: 0, y: 0, width: 1728, height: 1117 } })
    const active = win({ frame: { x: 100, y: 100, width: 400, height: 300 } })
    expect(isFullscreen([background, active], [DISPLAY])).toBe(false)
  })

  it('false when nothing is focused — the desktop is not fullscreen', () => {
    expect(isFullscreen([win({ active: false })], [DISPLAY])).toBe(false)
    expect(isFullscreen([], [DISPLAY])).toBe(false)
  })

  it('does not blind itself on a helper too old to report frames', () => {
    const { frame, ...noFrame } = win()
    void frame
    expect(isFullscreen([noFrame as DetectedWindow], [DISPLAY])).toBe(false)
  })

  it('ignores a non-layer-0 active window', () => {
    const active = win({ layer: 25, frame: { x: 0, y: 0, width: 1728, height: 1117 } })
    expect(isFullscreen([active], [DISPLAY])).toBe(false)
  })

  it('treats borderless full-display video as fullscreen — the intended direction', () => {
    // Indistinguishable from native fullscreen via CGWindowList, and hiding
    // Desk is the safe failure.
    const active = win({ name: 'IINA', frame: { x: 0, y: 0, width: 1728, height: 1117 } })
    expect(isFullscreen([active], [DISPLAY])).toBe(true)
  })
})

describe('createFullscreenWatcher', () => {
  it('reports a change exactly once per transition', async () => {
    let windows: DetectedWindow[] = [win()]
    const onChange = vi.fn()
    const watcher = createFullscreenWatcher({
      onChange,
      readDisplays: () => [DISPLAY],
      readWindows: async () => windows,
    })

    await watcher.pollNow()
    expect(onChange).not.toHaveBeenCalled()
    expect(watcher.isFullscreen()).toBe(false)

    windows = [win({ frame: { x: 0, y: 0, width: 1728, height: 1117 } })]
    await watcher.pollNow()
    await watcher.pollNow()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(watcher.isFullscreen()).toBe(true)

    windows = [win()]
    await watcher.pollNow()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps the last known state when a poll fails rather than flapping', async () => {
    let fail = false
    const onChange = vi.fn()
    const watcher = createFullscreenWatcher({
      onChange,
      readDisplays: () => [DISPLAY],
      readWindows: async () => {
        if (fail) throw new Error('helper spawn failed')
        return [win({ frame: { x: 0, y: 0, width: 1728, height: 1117 } })]
      },
    })

    await watcher.pollNow()
    expect(watcher.isFullscreen()).toBe(true)

    fail = true
    await watcher.pollNow()
    expect(watcher.isFullscreen()).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('never stacks helper spawns', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const watcher = createFullscreenWatcher({
      onChange: () => {},
      readDisplays: () => [DISPLAY],
      readWindows: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight--
        return [win()]
      },
    })

    await Promise.all([watcher.pollNow(), watcher.pollNow(), watcher.pollNow()])
    expect(maxInFlight).toBe(1)
  })

  it('start and stop are idempotent', () => {
    const watcher = createFullscreenWatcher({
      onChange: () => {},
      readDisplays: () => [DISPLAY],
      readWindows: async () => [win()],
      intervalMs: 10_000,
    })
    watcher.start()
    watcher.start()
    watcher.stop()
    watcher.stop()
    expect(watcher.isFullscreen()).toBe(false)
  })
})
