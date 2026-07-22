import { describe, it, expect } from 'vitest'
import { computeThreadLayoutMode, widthBudgetForMode, PANEL_WIDTHS } from './panelLayout'

describe('computeThreadLayoutMode', () => {
  it('picks three-panel at and above 1180px', () => {
    expect(computeThreadLayoutMode(1180)).toBe('three-panel')
    expect(computeThreadLayoutMode(1440)).toBe('three-panel')
  })

  it('picks two-panel between 800 and 1179px', () => {
    expect(computeThreadLayoutMode(800)).toBe('two-panel')
    expect(computeThreadLayoutMode(1179)).toBe('two-panel')
  })

  it('picks thread-drawer below 800px', () => {
    expect(computeThreadLayoutMode(799)).toBe('thread-drawer')
    expect(computeThreadLayoutMode(320)).toBe('thread-drawer')
  })

  // plans/chat-threads.md Phase 6 item 6 — the named widths from the plan's
  // "Electron window default/minimum" and responsive-mode tables, asserted
  // explicitly rather than only at the boundary values above.
  it('resolves the plan-named widths (640, 800, 960, 1180, 1440) to their documented mode', () => {
    expect(computeThreadLayoutMode(640)).toBe('thread-drawer') // Electron window minimum
    expect(computeThreadLayoutMode(800)).toBe('two-panel') // responsive-mode floor
    expect(computeThreadLayoutMode(960)).toBe('two-panel') // Electron window default
    expect(computeThreadLayoutMode(1180)).toBe('three-panel') // comfortable three-panel floor
    expect(computeThreadLayoutMode(1440)).toBe('three-panel') // common wide display
  })
})

describe('widthBudgetForMode', () => {
  it('sums main + thread + utility + two handles for three-panel', () => {
    const budget = widthBudgetForMode('three-panel')
    expect(budget.preferred).toBe(
      PANEL_WIDTHS.main.preferred + PANEL_WIDTHS.thread.preferred + PANEL_WIDTHS.utility.preferred + 2 * PANEL_WIDTHS.handle.preferred,
    )
    expect(budget.minimum).toBe(
      PANEL_WIDTHS.main.minimum + PANEL_WIDTHS.thread.minimum + PANEL_WIDTHS.utility.minimum + 2 * PANEL_WIDTHS.handle.minimum,
    )
  })

  it('sums main + thread + one handle for two-panel', () => {
    const budget = widthBudgetForMode('two-panel')
    expect(budget.preferred).toBe(PANEL_WIDTHS.main.preferred + PANEL_WIDTHS.thread.preferred + PANEL_WIDTHS.handle.preferred)
  })

  it('has no handles for thread-drawer (thread replaces main, nothing to seam)', () => {
    const budget = widthBudgetForMode('thread-drawer')
    expect(budget.preferred).toBe(PANEL_WIDTHS.thread.preferred)
    expect(budget.minimum).toBe(PANEL_WIDTHS.thread.minimum)
  })
})
