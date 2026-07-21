/**
 * Fullscreen suppression for Desk.
 *
 * When the frontmost app is fullscreen, Desk hides. **A false positive merely
 * hides Desk, which is safer than interrupting fullscreen focus** — so the
 * heuristic deliberately fails closed.
 *
 * Nothing in Bond could answer this before: `DetectedWindow` carried no bounds
 * and no layer, and window polling is *Sense-gated* — it stops when Sense is
 * disabled, while Desk is explicitly required to keep running and keep hiding
 * on fullscreen in that state. So this is an independent low-rate spawn of the
 * same helper binary, owned by main (which is where `win.hide()` lives anyway).
 *
 * Private CGS APIs remain out of scope.
 */
import { execFile } from 'node:child_process'
import { resolveHelperPath } from '../daemon/sense/helpers'
import type { DetectedWindow, WindowFrame } from '../shared/sense'

/** 1–2 Hz. This is a visibility check, not a capture pipeline. */
const POLL_INTERVAL_MS = 750
const HELPER_TIMEOUT_MS = 2_000

/**
 * How close to the display's full size counts as covering it. Slack absorbs
 * rounding and the odd off-by-one from CoreGraphics point conversion.
 */
const COVERAGE_SLACK_PT = 2

export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A layer-0 window is fullscreen when it covers its entire display **including
 * the menu bar strip** — an ordinary maximised window stops below the bar.
 * That top edge is the whole discriminator.
 *
 * Borderless full-display video is indistinguishable from native fullscreen
 * here and is treated as fullscreen. That is the intended failure direction.
 */
export function coversDisplay(frame: WindowFrame, display: DisplayBounds): boolean {
  const spansWidth = frame.width >= display.width - COVERAGE_SLACK_PT
  const spansHeight = frame.height >= display.height - COVERAGE_SLACK_PT
  const atTop = frame.y <= display.y + COVERAGE_SLACK_PT
  const atLeft = frame.x <= display.x + COVERAGE_SLACK_PT
  return spansWidth && spansHeight && atTop && atLeft
}

/**
 * Decide from one helper snapshot. Exported so the rule is testable without
 * spawning anything.
 *
 * Returns `true` (suppress) whenever the answer is unclear: no active window,
 * a window with no frame, an unreadable snapshot. Failing closed here costs a
 * hidden hairline; failing open puts Desk over someone's fullscreen video.
 */
export function isFullscreen(windows: DetectedWindow[], displays: DisplayBounds[]): boolean {
  const active = windows.find(w => w.active)
  if (!active) return false // nothing focused at all — the desktop, not fullscreen
  if (!active.frame) return false // a helper too old to report frames must not blind Desk
  if (active.layer !== undefined && active.layer !== 0) return false

  return displays.some(display => coversDisplay(active.frame!, display))
}

export interface FullscreenWatcher {
  start(): void
  stop(): void
  isFullscreen(): boolean
  /** Force one poll now (tests, a wake event). */
  pollNow(): Promise<void>
}

export interface FullscreenWatcherOptions {
  onChange: (fullscreen: boolean) => void
  /** Injected in tests; production reads Electron's display list. */
  readDisplays: () => DisplayBounds[]
  /** Injected in tests; production spawns the helper. */
  readWindows?: () => Promise<DetectedWindow[]>
  intervalMs?: number
}

function spawnHelper(): Promise<DetectedWindow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveHelperPath('bond-window-helper'),
      ['--json'],
      { timeout: HELPER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`bond-window-helper failed: ${stderr || err.message}`))
        try {
          const parsed = JSON.parse(stdout.trim())
          resolve(Array.isArray(parsed) ? (parsed as DetectedWindow[]) : [])
        } catch (e) {
          reject(new Error(`Failed to parse window-helper output: ${e}`))
        }
      }
    )
  })
}

export function createFullscreenWatcher(options: FullscreenWatcherOptions): FullscreenWatcher {
  const readWindows = options.readWindows ?? spawnHelper
  let timer: ReturnType<typeof setInterval> | null = null
  let fullscreen = false
  let polling = false

  async function poll(): Promise<void> {
    if (polling) return // never stack spawns
    polling = true
    try {
      const windows = await readWindows()
      const next = isFullscreen(windows, options.readDisplays())
      if (next !== fullscreen) {
        fullscreen = next
        options.onChange(fullscreen)
      }
    } catch {
      // A failed poll leaves the last known state. Flapping Desk in and out of
      // view because a helper spawn failed once is worse than a stale answer.
    } finally {
      polling = false
    }
  }

  return {
    start(): void {
      if (timer) return
      poll()
      timer = setInterval(poll, options.intervalMs ?? POLL_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) { clearInterval(timer); timer = null }
    },
    isFullscreen: () => fullscreen,
    pollNow: poll,
  }
}
