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

/**
 * The window's content-width floor when only the chat panel is visible — the
 * main panel's own `minSizePx`, so the composer never breaks. This is what
 * lets a chat-only window shrink well below the old fixed 640: the native
 * minimum is derived per open-panel set (see `windowMinWidthForPanels`), not
 * pinned to the widest layout. Kept in sync with `MAIN_WINDOW_MIN_WIDTH` in
 * `src/main/index.ts` (separate process, can't share the constant) and with
 * the `main` BondPanel's `minSizePx` in `App.vue`.
 */
export const CHAT_MIN_WIDTH = 400

/**
 * The native window minimum content width for a given set of visible side
 * panels: the chat floor plus each open panel's own hard minimum. With
 * nothing open it's just `CHAT_MIN_WIDTH`; each panel that opens raises the
 * floor by exactly its minimum and each that closes lowers it again, so the
 * window can always shrink back to fit whatever is actually on screen.
 * Handles net ~0px width (their negative margins absorb the 8px bar), so they
 * don't figure into the floor.
 */
export function windowMinWidthForPanels(visible: { thread: boolean; utility: boolean }): number {
  let min = CHAT_MIN_WIDTH
  if (visible.thread) min += PANEL_WIDTHS.thread.minimum
  if (visible.utility) min += PANEL_WIDTHS.utility.minimum
  return min
}

/** The px width to grow/shrink the window by when a side panel opens/closes. */
export function panelWidthFallback(panel: 'thread' | 'utility'): number {
  return PANEL_WIDTHS[panel].preferred
}
