/**
 * Per-display notch and menu-bar geometry.
 *
 * **Electron exposes none of this.** `screen.getPrimaryDisplay()` has no
 * `safeAreaInsets`, no `auxiliaryTopLeftArea`, no safe-area field of any name;
 * [electron#31478](https://github.com/electron/electron/issues/31478) asked for
 * exactly that and was closed not-planned. CSS `env(safe-area-inset-top)`
 * returns `0px` — Chromium only wires it on iOS/Android.
 *
 * So: ask `bond-notch-helper`, and fall back to a heuristic when it is missing
 * (a packaged build without it, a failed compile). A few points of slop at the
 * notch edge is invisible, so the fallback is good enough to render a shape.
 */
import { execFile } from 'node:child_process'
import type { Display } from 'electron'
import { resolveHelperPath } from '../daemon/sense/helpers'

export interface NotchGeometry {
  displayId: number
  notched: boolean
  /** Points. 0 when not notched. */
  notchWidth: number
  notchHeight: number
  menuBarHeight: number
  /** True when the numbers came from the native helper rather than the fallback. */
  measured: boolean
}

interface HelperRow {
  displayId: number
  notched: boolean
  notchWidth: number
  notchHeight: number
  menuBarHeight: number
}

/**
 * The 16" MacBook Pro reference measurement, used only by the fallback.
 * The notch is a fixed number of *physical* pixels, so its point size scales
 * linearly with framebuffer width — **never hardcode a table**, and recompute
 * on `display-metrics-changed`. Published "220 × 38" tables are the *More
 * Space* scaled mode, not the default.
 */
const NOTCH_REFERENCE = { widthPt: 185, basisPt: 1728 }

/**
 * Menu bar detection: `workArea.y - bounds.y`, **never**
 * `bounds.height - workArea.height`. The latter silently includes the Dock
 * height whenever the Dock is at the bottom.
 *
 * On a secondary display with "Displays have separate Spaces" off this is 0
 * because there is no menu bar there at all — so a zero result means "no bar
 * *on this display*", not "no bar exists".
 */
export function menuBarHeightFor(display: Display): number {
  return Math.max(0, display.workArea.y - display.bounds.y)
}

/** Good enough to render a shape when the native helper is unavailable. */
export function fallbackGeometry(display: Display): NotchGeometry {
  const menuBar = menuBarHeightFor(display)
  const notched = display.internal && menuBar >= 30
  return {
    displayId: display.id,
    notched,
    notchWidth: notched
      ? Math.round(NOTCH_REFERENCE.widthPt * (display.bounds.width / NOTCH_REFERENCE.basisPt))
      : 0,
    notchHeight: notched ? menuBar - 1 : 0,
    menuBarHeight: menuBar,
    measured: false,
  }
}

function runHelper(timeoutMs: number): Promise<HelperRow[]> {
  return new Promise((resolve, reject) => {
    execFile(resolveHelperPath('bond-notch-helper'), [], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`bond-notch-helper failed: ${stderr || err.message}`))
      try {
        const parsed = JSON.parse(stdout.trim())
        resolve(Array.isArray(parsed) ? (parsed as HelperRow[]) : [])
      } catch (e) {
        reject(new Error(`Failed to parse notch-helper output: ${e}`))
      }
    })
  })
}

/** Cached because it only changes on a display event, and it spawns a process. */
let cache: Map<number, NotchGeometry> | null = null

export function invalidateNotchGeometry(): void {
  cache = null
}

/**
 * Geometry for every display, keyed by Electron `Display.id`.
 *
 * On macOS `Display.id` **is** the `CGDirectDisplayID`, which is what
 * `NSScreenNumber` reports — that is the whole match. (`Display.id` can change
 * across unplug/replug; if that ever matters, get
 * `CGDisplayCreateUUIDFromDisplayID` from the helper too.)
 */
export async function loadNotchGeometry(
  displays: Display[],
  opts: { timeoutMs?: number } = {}
): Promise<Map<number, NotchGeometry>> {
  if (cache) return cache

  const result = new Map<number, NotchGeometry>()
  let rows: HelperRow[] = []
  try {
    rows = await runHelper(opts.timeoutMs ?? 3_000)
  } catch (error) {
    console.warn('[Desk] notch helper unavailable, using heuristic:', error instanceof Error ? error.message : error)
  }

  const byId = new Map(rows.map(row => [row.displayId, row]))
  for (const display of displays) {
    const row = byId.get(display.id)
    result.set(display.id, row
      ? {
          displayId: display.id,
          notched: !!row.notched,
          notchWidth: Number(row.notchWidth) || 0,
          notchHeight: Number(row.notchHeight) || 0,
          // Prefer Electron's own figure when the helper reports nothing — a
          // secondary display legitimately has no menu bar.
          menuBarHeight: Number(row.menuBarHeight) || menuBarHeightFor(display),
          measured: true,
        }
      : fallbackGeometry(display))
  }

  cache = result
  return result
}

export function geometryFor(display: Display, loaded: Map<number, NotchGeometry> | null): NotchGeometry {
  return loaded?.get(display.id) ?? fallbackGeometry(display)
}

/**
 * How far below the menu bar the Rest hairline sits.
 *
 * **Anything drawn inside the notch's own footprint is physically invisible.**
 * The framebuffer still contains those pixels — a screenshot shows them
 * perfectly — but the display cannot emit light through the camera housing.
 * "Costs zero pixels" has to mean *flanking* the notch, not *behind* it.
 *
 * Below the bar is the safe strip: never occluded, never colliding with menu
 * titles or status extras, and trivially satisfying the rule that nothing
 * interactive may overlap the menu bar outside the notch's x-range.
 */
export const REST_MARK_STRIP = 8

/**
 * The Rest shape: the notch's own width on a notched display, or
 * DynamicNotchKit's 300 pt fallback lozenge elsewhere.
 *
 * Height runs from the top of the screen to just past the menu bar, so the
 * hairline has somewhere visible to live. The shape itself paints nothing at
 * rest — only the hairline does.
 */
export function restShape(geometry: NotchGeometry): { width: number; height: number } {
  const width = geometry.notched ? geometry.notchWidth : 300
  return { width, height: Math.max(24, geometry.menuBarHeight) + REST_MARK_STRIP }
}
