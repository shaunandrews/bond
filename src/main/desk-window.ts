/**
 * The Desk NSPanel.
 *
 * Load-bearing details, each of which took a measurement to find:
 *
 *  - **`enableLargerThanScreen: true` is the whole feature.** Seven configs
 *    were probed asking for `y: 0`; six came back `y: 33`. Only that flag —
 *    *with* `frame: false` — makes `constrainFrameRect:toScreen:` return the
 *    requested rect verbatim instead of AppKit's constrained one. The docs
 *    describe it only as "Enable the window to be resized larger than screen",
 *    which is why nobody finds it.
 *  - **Level 27, not screen-saver.** The WindowServer menu bar is layer 24 and
 *    Control Center extras are 25, so 27 sits above both — but open menus are
 *    101, so a menu the user opens correctly draws *over* Desk. `screen-saver`
 *    would paint over open menus, which is the single most common way these
 *    overlays look broken.
 *  - **`type: 'panel'` forces the level to floating (3) at construction**, so
 *    `setAlwaysOnTop` must be called *after*.
 *  - **Never animate `setBounds`.** `setBounds(bounds, true)` blocks the main
 *    process for ~340ms. The window is created once at full size, positioned
 *    once, and all motion is CSS transform inside that fixed rect.
 *  - **Renderer `mousemove` is unusable here.** With
 *    `setIgnoreMouseEvents(true, {forward: true})`, forwarded mouse-move on
 *    macOS only fires while a button is held (electron#26718), and forwarding
 *    stops entirely when some non-Electron windows hold focus (#33281). So
 *    main polls the cursor instead — `getCursorScreenPoint()` benchmarked at
 *    ~2µs, making 60Hz free.
 */
import { BrowserWindow, screen, powerMonitor, type Display } from 'electron'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFullscreenWatcher, type FullscreenWatcher } from './desk-fullscreen'
import {
  geometryFor,
  invalidateNotchGeometry,
  loadNotchGeometry,
  restShape,
  type NotchGeometry,
} from './notch-geometry'
import type { DeskWindowHost, OpenDeskResult } from './desk'
import type { DeskHotRect, DeskWindowGeometry } from '../shared/desk-window'

/**
 * The window is created at its fully-expanded size and never resized, so this
 * must be large enough for every state Desk will ever show — plus transparent
 * padding for the CSS drop-shadow bleed.
 */
const WINDOW_WIDTH = 640
/** Tall enough for the fully-expanded Open panel plus shadow bleed. */
const WINDOW_HEIGHT = 520

/** ~60Hz. The poll is the outer gate; real events flow once non-click-through. */
const CURSOR_POLL_MS = 16

/** WindowServer has not settled when a display event fires. */
const DISPLAY_DEBOUNCE_MS = 300
const DISPLAY_SETTLE_MS = 1_000

/** How long the pointer must sit on another display before Desk follows it. */
const FOLLOW_DWELL_MS = 1_000

export interface DeskWindowOptions {
  preloadPath: string
  /** Dev server URL, or undefined to load the built file. */
  rendererUrl?: string
  rendererFile?: string
}

/**
 * Desk-window diagnostics.
 *
 * The Desk panel is a non-activating NSPanel with no menu and no obvious way to
 * open devtools, and its main-process side logs to whatever terminal is running
 * the dev server. Both are invisible to anyone debugging from outside, so this
 * goes to a file instead. Enabled by BOND_DESK_DEBUG=1.
 */
const DESK_LOG = join(homedir(), '.bond', 'desk-debug.log')
const deskDebug = process.env.BOND_DESK_DEBUG === '1'

function deskLog(message: string, detail?: unknown): void {
  if (!deskDebug) return
  try {
    const line = detail === undefined ? message : `${message} ${JSON.stringify(detail)}`
    appendFileSync(DESK_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch { /* diagnostics must never break the panel */ }
}

interface Point { x: number; y: number }

function pointIn(point: Point, rect: DeskHotRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height
}

/**
 * **Hard rule: never leave a non-click-through region overlapping
 * `y < menuBarHeight` outside the notch's own x-range.** That is how you break
 * the menu bar for the entire machine.
 *
 * The renderer proposes rects; this clamps them. Exported because it is the
 * single safety invariant of the whole surface and deserves its own tests.
 */
export function clampHotRects(
  rects: DeskHotRect[],
  bounds: { width: number; height: number },
  notch: { menuBarHeight: number; restWidth: number }
): DeskHotRect[] {
  const notchLeft = bounds.width / 2 - notch.restWidth / 2
  const notchRight = bounds.width / 2 + notch.restWidth / 2

  const out: DeskHotRect[] = []
  for (const rect of rects) {
    // Clip to the window first — a rect outside it can never be interactive.
    const x = Math.max(0, Math.min(rect.x, bounds.width))
    const y = Math.max(0, Math.min(rect.y, bounds.height))
    const right = Math.max(x, Math.min(rect.x + rect.width, bounds.width))
    const bottom = Math.max(y, Math.min(rect.y + rect.height, bounds.height))
    if (right <= x || bottom <= y) continue

    if (y >= notch.menuBarHeight) {
      out.push({ x, y, width: right - x, height: bottom - y })
      continue
    }

    // The part above the menu bar survives only inside the notch's x-range.
    const clippedLeft = Math.max(x, notchLeft)
    const clippedRight = Math.min(right, notchRight)
    if (clippedRight > clippedLeft) {
      out.push({
        x: clippedLeft,
        y,
        width: clippedRight - clippedLeft,
        height: Math.min(bottom, notch.menuBarHeight) - y,
      })
    }

    // ...and the part below it is unrestricted.
    if (bottom > notch.menuBarHeight) {
      out.push({ x, y: notch.menuBarHeight, width: right - x, height: bottom - notch.menuBarHeight })
    }
  }
  return out.filter(r => r.width > 0 && r.height > 0)
}

/** Anchor to `bounds`, never `workArea` — we want the physical top edge. */
export function originFor(display: Display, size: { width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.round(display.bounds.x + display.bounds.width / 2 - size.width / 2),
    y: display.bounds.y,
  }
}

export function createDeskWindowHost(options: DeskWindowOptions): DeskWindowHost {
  let win: BrowserWindow | null = null
  let cursorTimer: ReturnType<typeof setInterval> | null = null
  let clickThrough = true
  let hotRects: DeskHotRect[] = []
  let geometryByDisplay: Map<number, NotchGeometry> | null = null
  let currentDisplayId: number | null = null
  let suppressed = false
  let watcher: FullscreenWatcher | null = null
  let followSince: { displayId: number; at: number } | null = null
  let rendererReady = false
  let interactive = false

  function activeDisplay(): Display {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  function geometryPayload(display: Display): DeskWindowGeometry {
    const geometry = geometryFor(display, geometryByDisplay)
    const rest = restShape(geometry)
    return {
      windowWidth: WINDOW_WIDTH,
      windowHeight: WINDOW_HEIGHT,
      restWidth: rest.width,
      restHeight: rest.height,
      menuBarHeight: geometry.menuBarHeight,
      notched: geometry.notched,
      measured: geometry.measured,
      displayId: display.id,
    }
  }

  function sendGeometry(display: Display): void {
    if (!win || win.isDestroyed()) return
    win.webContents.send('desk:geometry', geometryPayload(display))
  }

  /** Where we last put the window, so drift can be detected and undone. */
  let expectedBounds: { x: number; y: number; width: number; height: number } | null = null

  /** Position (never resize) the window on a display. */
  function anchorTo(display: Display): void {
    if (!win || win.isDestroyed()) return
    const origin = originFor(display, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
    expectedBounds = { ...origin, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
    win.setBounds(expectedBounds)
    currentDisplayId = display.id
    sendGeometry(display)
  }

  /**
   * NOTE on Space switching, so nobody tries this again.
   *
   * The panel animates along with a Space transition, and there is no fix
   * available from JavaScript. The window's FRAME never changes — measured
   * over a session of real Space switches, a bounds watcher fired zero times —
   * because WindowServer is compositing the whole Space, not moving the
   * window. Watching bounds cannot see it, so re-anchoring cannot correct it.
   *
   * The only real fix is `NSWindowCollectionBehaviorStationary`, and the
   * string "stationary" does not appear anywhere in the Electron package.
   * `setVisibleOnAllWorkspaces` covers `canJoinAllSpaces` and nothing else,
   * and `electron_ns_panel.mm` re-ORs its own collection behaviour into every
   * write regardless. Setting it requires in-process native access to the
   * NSWindow — i.e. a native addon.
   */

  function setClickThrough(next: boolean): void {
    if (!win || win.isDestroyed() || next === clickThrough) return
    clickThrough = next
    deskLog('clickThrough', { clickThrough })
    win.setIgnoreMouseEvents(clickThrough, { forward: true })
    win.webContents.send('desk:hover', !clickThrough)
  }

  let polls = 0
  function pollCursor(): void {
    if (!win || win.isDestroyed() || suppressed) {
      if (deskDebug && ++polls % 300 === 1) deskLog('poll skipped', { hasWin: !!win, suppressed })
      return
    }
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const local = { x: point.x - bounds.x, y: point.y - bounds.y }
    const inside = hotRects.some(rect => pointIn(local, rect))
    // Once a second while the cursor is anywhere near the top of the window.
    if (deskDebug && local.y >= -20 && local.y < 80 && ++polls % 60 === 1) {
      deskLog('poll', { point, bounds, local, rects: hotRects.length, inside })
    }
    setClickThrough(!inside)

    // Follow the user's display — but only from Rest, and only after the
    // pointer has settled. Moving the panel out from under an active
    // interaction is worse than being on the wrong screen for a second.
    if (inside || interactive) { followSince = null; return }
    const display = screen.getDisplayNearestPoint(point)
    if (display.id === currentDisplayId) { followSince = null; return }
    const now = Date.now()
    if (!followSince || followSince.displayId !== display.id) {
      followSince = { displayId: display.id, at: now }
      return
    }
    if (now - followSince.at >= FOLLOW_DWELL_MS) {
      followSince = null
      anchorTo(display)
    }
  }

  function applySuppression(fullscreen: boolean): void {
    suppressed = fullscreen
    if (!win || win.isDestroyed()) return
    if (fullscreen) {
      // `visibleOnFullScreen: false` is expected to be inert on a panel —
      // electron_ns_panel.mm re-ORs `fullScreenAuxiliary` into every
      // collection-behaviour write — so hide() is the only thing that works.
      win.hide()
      setClickThrough(true)
    } else if (!win.isVisible()) {
      win.showInactive()
    }
  }

  // Display changes: debounce, then re-apply once more after WindowServer settles.
  let displayTimer: ReturnType<typeof setTimeout> | null = null
  async function handleDisplayChange(): Promise<void> {
    if (displayTimer) clearTimeout(displayTimer)
    displayTimer = setTimeout(async () => {
      invalidateNotchGeometry()
      geometryByDisplay = await loadNotchGeometry(screen.getAllDisplays())
      anchorTo(activeDisplay())
      setTimeout(() => {
        if (win && !win.isDestroyed()) anchorTo(activeDisplay())
      }, DISPLAY_SETTLE_MS).unref?.()
    }, DISPLAY_DEBOUNCE_MS)
    displayTimer.unref?.()
  }

  function onMetricsChanged(_e: unknown, _display: Display, changedMetrics: string[]): void {
    if (!changedMetrics.some(m => m === 'bounds' || m === 'workArea' || m === 'scaleFactor')) return
    handleDisplayChange()
  }

  function attachSystemListeners(): void {
    screen.on('display-added', handleDisplayChange)
    screen.on('display-removed', handleDisplayChange)
    screen.on('display-metrics-changed', onMetricsChanged)
    // Waking is the most common way these windows end up on the wrong display
    // or back at y: 33, so a resume always forces a full re-anchor.
    powerMonitor.on('resume', handleDisplayChange)
  }

  function detachSystemListeners(): void {
    screen.removeListener('display-added', handleDisplayChange)
    screen.removeListener('display-removed', handleDisplayChange)
    screen.removeListener('display-metrics-changed', onMetricsChanged)
    powerMonitor.removeListener('resume', handleDisplayChange)
  }

  async function create(): Promise<void> {
    geometryByDisplay = await loadNotchGeometry(screen.getAllDisplays())
    const display = activeDisplay()
    const origin = originFor(display, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })

    win = new BrowserWindow({
      ...origin,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,      // native shadows do not render on transparent windows
      resizable: false,
      movable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true, // ← REQUIRED, or y is clamped to the menu bar
      type: 'panel',                // NSPanel nonactivating
      roundedCorners: false,        // the notch shape is drawn in CSS
      acceptFirstMouse: true,
      fullscreenable: false,
      backgroundColor: '#00000000',
      show: false,
      // Keep it out of Mission Control and App Exposé, where it would otherwise
      // scale down alongside real windows as an empty transparent rectangle.
      // Desk is chrome, not a window you switch to.
      hiddenInMissionControl: true,
      webPreferences: {
        preload: options.preloadPath,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        // REQUIRED. Bond's preload is an ES module, and a sandboxed renderer
        // cannot load one — it fails with "Cannot use import statement outside
        // a module", leaving window.bond and window.desk undefined and the
        // panel silently inert. Every other Bond window sets this too.
        sandbox: false,
      },
    })

    // type: 'panel' forces the level to floating (3) at construction, so this
    // must come after. 'main-menu' + 3 measures as NSWindow level 27.
    win.setAlwaysOnTop(true, 'main-menu', 3)
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: false,   // likely inert on a panel; hide() is the real mechanism
      skipTransformProcessType: true, // ← or Bond loses its Dock icon
    })
    win.setIgnoreMouseEvents(true, { forward: true })

    win.on('closed', () => {
      deskLog('window closed')
      win = null
      teardown()
    })

    // The panel has no devtools affordance of its own, so surface its console.
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      deskLog('renderer console', { level, message, line, source })
    })
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
      deskLog('PRELOAD ERROR', { preloadPath, error: String(error) })
    })
    win.webContents.on('did-fail-load', (_e, code, description) => {
      deskLog('did-fail-load', { code, description })
    })

    if (options.rendererUrl) {
      await win.loadURL(options.rendererUrl)
    } else if (options.rendererFile) {
      await win.loadFile(options.rendererFile)
    }

    currentDisplayId = display.id
    sendGeometry(display)
    deskLog('created', {
      bounds: win.getBounds(),
      geometry: geometryPayload(display),
      preload: options.preloadPath,
      url: options.rendererUrl ?? options.rendererFile,
    })

    watcher = createFullscreenWatcher({
      onChange: applySuppression,
      readDisplays: () => screen.getAllDisplays().map(d => ({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      })),
    })
    watcher.start()

    attachSystemListeners()
    cursorTimer = setInterval(pollCursor, CURSOR_POLL_MS)
    cursorTimer.unref?.()
  }

  function teardown(): void {
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null }
    if (displayTimer) { clearTimeout(displayTimer); displayTimer = null }
    watcher?.stop()
    watcher = null
    detachSystemListeners()
    rendererReady = false
    hotRects = []
    clickThrough = true
  }

  return {
    async open(): Promise<OpenDeskResult> {
      // Idempotent: a second call reveals the existing panel. Never activates —
      // clicking Desk must not bring Bond to the front.
      if (win && !win.isDestroyed()) {
        if (!suppressed && !win.isVisible()) win.showInactive()
        return { opened: true }
      }
      await create()
      if (!suppressed) win!.showInactive()
      return { opened: true }
    },

    close(): void {
      if (win && !win.isDestroyed()) win.close()
      win = null
      teardown()
    },

    isOpen(): boolean {
      return !!win && !win.isDestroyed()
    },

    /** Renderer callbacks, routed here by main's IPC handlers. */
    setHotRects(rects: DeskHotRect[]): void {
      deskLog('setHotRects in', rects)
      if (!win || win.isDestroyed()) return
      const display = screen.getAllDisplays().find(d => d.id === currentDisplayId) ?? activeDisplay()
      const geometry = geometryFor(display, geometryByDisplay)
      hotRects = clampHotRects(
        rects,
        { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
        { menuBarHeight: geometry.menuBarHeight, restWidth: restShape(geometry).width }
      )
      deskLog('setHotRects clamped', hotRects)
      // An Ask is an active interaction; do not move the panel underneath it.
      interactive = hotRects.some(r => r.height > restShape(geometry).height)
    },

    markReady(): void {
      deskLog('renderer ready')
      rendererReady = true
      if (win && !win.isDestroyed() && !suppressed && !win.isVisible()) win.showInactive()
    },

    isReady(): boolean {
      return rendererReady
    },
  }
}
