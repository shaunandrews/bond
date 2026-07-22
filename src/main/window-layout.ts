/**
 * Pure geometry for the main window's content-width management. The renderer
 * grows the window by a panel's width when it opens and shrinks it back when
 * it closes, always keeping the chat (left) panel's width — so a side panel
 * never squeezes the conversation, and closing it returns the window to where
 * it was.
 *
 * Kept separate from the Electron-calling wrapper in `src/main/index.ts` so
 * the clamping / edge-preservation math is testable with plain objects — no
 * BrowserWindow or screen module involved.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ContentResizeResult {
  /** The content bounds to apply, or null if no change is needed. */
  bounds: Rect | null
  /** The content width the window will have afterward. */
  width: number
}

/**
 * Grow or shrink the window's content width by `deltaWidth` (positive grows,
 * negative shrinks), clamped so it never drops below `minimumWidth` and never
 * exceeds the display's work area. The right edge moves first so the left edge
 * — where the chat panel lives — stays put; if growth would push the window
 * off the right of its display, the left edge slides in exactly enough, and
 * never crosses onto a neighbouring display.
 */
export function computeContentResize(
  current: Rect,
  workArea: Rect,
  opts: { deltaWidth: number; minimumWidth: number },
): ContentResizeResult {
  // Never demand more than the display can show — a floor wider than the work
  // area would force the window off-screen.
  const floor = Math.min(opts.minimumWidth, workArea.width)
  const targetWidth = Math.max(floor, Math.min(current.width + opts.deltaWidth, workArea.width))

  if (Math.round(targetWidth) === Math.round(current.width)) {
    return { bounds: null, width: current.width }
  }

  let newX = current.x
  const rightEdge = workArea.x + workArea.width
  // Growing past the display's right edge — pull the left edge back just enough.
  if (newX + targetWidth > rightEdge) newX = rightEdge - targetWidth
  // Never start left of the work area (covers a display narrower than target).
  newX = Math.max(newX, workArea.x)

  return { bounds: { x: newX, y: current.y, width: targetWidth, height: current.height }, width: targetWidth }
}
