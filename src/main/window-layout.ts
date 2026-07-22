/**
 * Pure geometry for `ensureContentWidth` — growing the main window's content
 * area so a newly-opened panel (the chat-threads middle panel, first) never
 * crushes an existing panel below its hard minimum when the display has room
 * to just make the window bigger.
 *
 * Kept separate from the Electron-calling wrapper in `src/main/index.ts` so
 * the clamping/edge-preservation math is testable with plain objects — no
 * BrowserWindow or screen module involved.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface EnsureContentWidthResult {
  /** The content bounds to apply, or null if no resize is needed. */
  bounds: Rect | null
  /** The width the window will have after applying `bounds` (or has now, if null). */
  width: number
  reachedPreferred: boolean
}

/**
 * Never shrinks (only called when opening a panel needs more room) and never
 * moves the window if it already fits. Growth prefers the right edge first
 * (preserves the left edge — where the user is likely still looking), then
 * takes space from the left, then clamps to the display's work area entirely
 * if even that isn't enough.
 */
export function computeEnsuredContentWidth(
  current: Rect,
  workArea: Rect,
  opts: { preferredWidth: number; minimumWidth: number },
): EnsureContentWidthResult {
  if (current.width >= opts.preferredWidth) {
    return { bounds: null, width: current.width, reachedPreferred: true }
  }

  const targetWidth = Math.min(opts.preferredWidth, workArea.width)
  const rightSpace = workArea.x + workArea.width - current.x

  let newX = current.x
  if (targetWidth > rightSpace) {
    // Not enough room growing rightward alone — take the shortfall from the
    // left edge, clamped so the window never starts left of the work area.
    const overflow = targetWidth - rightSpace
    newX = Math.max(workArea.x, current.x - overflow)
  }
  // Final clamp: whatever newX ended up as, the window must still fit inside
  // the work area on the right too (covers a display narrower than targetWidth).
  newX = Math.min(newX, workArea.x + workArea.width - targetWidth)
  newX = Math.max(newX, workArea.x)

  return {
    bounds: { x: newX, y: current.y, width: targetWidth, height: current.height },
    width: targetWidth,
    reachedPreferred: targetWidth >= opts.preferredWidth,
  }
}
