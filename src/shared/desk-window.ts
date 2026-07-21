/**
 * The main ↔ Desk-renderer contract.
 *
 * Kept separate from `shared/desk.ts` (the daemon's data model) because this is
 * pure window plumbing: geometry main measured, and hit regions the renderer
 * reports back so main's cursor poll knows where to stop being click-through.
 */

export interface DeskWindowGeometry {
  /** The fixed window size. It is created once at this size and never resized. */
  windowWidth: number
  windowHeight: number
  /** The Rest shape — the notch's own footprint, or the 300pt fallback lozenge. */
  restWidth: number
  restHeight: number
  /** `workArea.y - bounds.y`. Zero on a display with no menu bar of its own. */
  menuBarHeight: number
  notched: boolean
  /** False when the geometry came from the heuristic rather than the helper. */
  measured: boolean
  displayId: number
}

/**
 * A rectangle, in window-local CSS pixels, that should receive mouse events.
 * Main validates and clamps every one of these before storing it — a renderer
 * bug must not be able to take the menu bar down with it.
 */
export interface DeskHotRect {
  x: number
  y: number
  width: number
  height: number
}

/** The `window.desk` surface, exposed only to the Desk window. */
export interface DeskBridge {
  /** Renderer → main: where mouse events should land, per discrete state change. */
  setHotRects(rects: DeskHotRect[]): void
  /** Main → renderer: the cursor entered or left a hot rect. */
  onHover(fn: (inside: boolean) => void): () => void
  /** Main → renderer: geometry resolved, or the display changed under us. */
  onGeometry(fn: (geometry: DeskWindowGeometry) => void): () => void
  /** Renderer → main: mounted and ready to be shown. */
  ready(): void
}

declare global {
  interface Window {
    desk?: DeskBridge
  }
}
