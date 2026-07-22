/**
 * Pure width math for the chat-threads panel layout (plans/chat-threads.md,
 * "Layout and window policy"). Kept framework-free so it's trivially unit
 * tested — App.vue's layout coordinator (Phase 5) is the only consumer.
 */

/** Preferred and hard-minimum content widths per surface, in px. */
export const PANEL_WIDTHS = {
  main: { preferred: 640, minimum: 480 },
  thread: { preferred: 360, minimum: 320 },
  utility: { preferred: 320, minimum: 280 },
  /** One seam per visible handle. */
  handle: { preferred: 8, minimum: 4 },
} as const

export type ThreadLayoutMode = 'three-panel' | 'two-panel' | 'thread-drawer'

/** Below this, even main + thread (no utility) don't comfortably fit. */
export const TWO_PANEL_MIN_WIDTH = 800
/** At or above this, main + thread + utility all fit comfortably. */
export const THREE_PANEL_MIN_WIDTH = 1180

/**
 * Which thread layout an open thread should use for the given available
 * content width. Only meaningful while a thread is open — the ordinary
 * main+utility two-panel layout is unaffected by this and unconditional.
 */
export function computeThreadLayoutMode(availableWidth: number): ThreadLayoutMode {
  if (availableWidth >= THREE_PANEL_MIN_WIDTH) return 'three-panel'
  if (availableWidth >= TWO_PANEL_MIN_WIDTH) return 'two-panel'
  return 'thread-drawer'
}

/**
 * Sum of preferred/minimum widths for the panels that would be visible in a
 * given thread layout mode, plus one handle per seam between visible panels.
 * Feeds `ensureContentWidth` — the window should grow to fit `preferred`,
 * clamped by the display, and never below `minimum`.
 */
export function widthBudgetForMode(mode: ThreadLayoutMode): { preferred: number; minimum: number } {
  const surfaces =
    mode === 'three-panel' ? (['main', 'thread', 'utility'] as const)
    : mode === 'two-panel' ? (['main', 'thread'] as const)
    : (['thread'] as const) // thread-drawer replaces main; no seams to size

  const handles = Math.max(0, surfaces.length - 1)
  return {
    preferred: surfaces.reduce((sum, s) => sum + PANEL_WIDTHS[s].preferred, 0) + handles * PANEL_WIDTHS.handle.preferred,
    minimum: surfaces.reduce((sum, s) => sum + PANEL_WIDTHS[s].minimum, 0) + handles * PANEL_WIDTHS.handle.minimum,
  }
}
