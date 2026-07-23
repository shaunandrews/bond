import { describe, it, expect } from 'vitest'
import { windowMinWidthForPanels, panelWidthFallback, CHAT_MIN_WIDTH, PANEL_WIDTHS } from './panelLayout'

describe('windowMinWidthForPanels', () => {
  it('is just the chat floor when nothing is open — so a chat-only window can shrink small', () => {
    expect(windowMinWidthForPanels({ thread: false, utility: false })).toBe(CHAT_MIN_WIDTH)
  })

  it('adds the utility panel minimum when only the utility panel is open', () => {
    expect(windowMinWidthForPanels({ thread: false, utility: true })).toBe(CHAT_MIN_WIDTH + PANEL_WIDTHS.utility.minimum)
  })

  it('adds the thread panel minimum when only a thread column is open', () => {
    expect(windowMinWidthForPanels({ thread: true, utility: false })).toBe(CHAT_MIN_WIDTH + PANEL_WIDTHS.thread.minimum)
  })

  it('sums chat + thread + utility when all three columns are open', () => {
    expect(windowMinWidthForPanels({ thread: true, utility: true })).toBe(
      CHAT_MIN_WIDTH + PANEL_WIDTHS.thread.minimum + PANEL_WIDTHS.utility.minimum,
    )
  })

  it('is strictly larger with a panel open than without — every open panel raises the floor', () => {
    expect(windowMinWidthForPanels({ thread: true, utility: false })).toBeGreaterThan(windowMinWidthForPanels({ thread: false, utility: false }))
    expect(windowMinWidthForPanels({ thread: true, utility: true })).toBeGreaterThan(windowMinWidthForPanels({ thread: true, utility: false }))
  })
})

describe('panelWidthFallback', () => {
  it('returns each panel\'s preferred width as the open/close resize amount', () => {
    expect(panelWidthFallback('thread')).toBe(PANEL_WIDTHS.thread.preferred)
    expect(panelWidthFallback('utility')).toBe(PANEL_WIDTHS.utility.preferred)
  })
})
