import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { DetectedWindow } from '../../shared/sense'
import { resolveHelperPath } from './helpers'

export interface WindowSnapshot {
  windows: DetectedWindow[]
  activeWindow: DetectedWindow | null
  timestamp: string
}

/**
 * How long a pushed snapshot stays authoritative.
 *
 * Main polls the helper at ~1.3Hz, so anything older than this means main has
 * gone away (quit, reloading) and the daemon should fall back to spawning the
 * helper itself — degraded, because titles will be blank, but not dead.
 */
const PUSH_TTL_MS = 6_000

export interface WindowDetector extends EventEmitter {
  on(event: 'appSwitch', listener: (current: DetectedWindow, previous: DetectedWindow | null) => void): this
  emit(event: 'appSwitch', current: DetectedWindow, previous: DetectedWindow | null): boolean
  getSnapshot(): Promise<WindowSnapshot>
  getLastSnapshot(): WindowSnapshot | null
  /** Main pushing a snapshot taken with Screen Recording permission. */
  acceptSnapshot(windows: DetectedWindow[]): void
  startPolling(): void
  stopPolling(): void
}

const POLL_INTERVAL_MS = 2_000
const MIN_VISIBLE_AREA = 3_000

/**
 * Wraps bond-window-helper for window detection.
 * Polls every 2s and emits 'appSwitch' when the active app changes.
 */
export function createWindowDetector(): WindowDetector {
  const emitter = new EventEmitter() as WindowDetector
  const helperPath = resolveHelperPath('bond-window-helper')
  let lastSnapshot: WindowSnapshot | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let pushed: { snapshot: WindowSnapshot; at: number } | null = null

  function capture(): Promise<WindowSnapshot> {
    return new Promise((resolve, reject) => {
      execFile(helperPath, ['--json', '--min-visible-area', String(MIN_VISIBLE_AREA)], {
        timeout: 5_000,
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`bond-window-helper failed: ${stderr || err.message}`))
          return
        }

        try {
          const windows: DetectedWindow[] = JSON.parse(stdout.trim())
          const activeWindow = windows.find(w => w.active) ?? null
          const snapshot: WindowSnapshot = {
            windows,
            activeWindow,
            timestamp: new Date().toISOString(),
          }
          resolve(snapshot)
        } catch (e) {
          reject(new Error(`Failed to parse window-helper output: ${e}`))
        }
      })
    })
  }

  async function poll(): Promise<void> {
    try {
      const snapshot = await capture()
      const previousActive = lastSnapshot?.activeWindow ?? null
      const currentActive = snapshot.activeWindow

      // Detect app switch
      if (currentActive && previousActive) {
        const switched = currentActive.bundleId !== previousActive.bundleId ||
                         currentActive.title !== previousActive.title
        if (switched) {
          emitter.emit('appSwitch', currentActive, previousActive)
        }
      } else if (currentActive && !previousActive) {
        emitter.emit('appSwitch', currentActive, null)
      }

      lastSnapshot = snapshot
    } catch {
      // Silently skip failed polls
    }
  }

  /**
   * Prefer main's snapshot. `kCGWindowName` returns an EMPTY STRING for other
   * apps' windows unless the calling process holds Screen Recording permission
   * — and the daemon runs under launchd as bare node, which does not. Spawning
   * the helper here yields app names with no titles, which collapses every
   * window of an app into one indistinguishable resource.
   */
  emitter.getSnapshot = async () => {
    if (pushed && Date.now() - pushed.at < PUSH_TTL_MS) return pushed.snapshot
    return capture()
  }

  emitter.acceptSnapshot = (windows: DetectedWindow[]) => {
    const snapshot: WindowSnapshot = {
      windows,
      activeWindow: windows.find(w => w.active) ?? null,
      timestamp: new Date().toISOString(),
    }
    pushed = { snapshot, at: Date.now() }
    // App-switch detection rides the pushed stream too, so event-driven
    // captures keep firing while main is the source of truth.
    const previousActive = lastSnapshot?.activeWindow ?? null
    const currentActive = snapshot.activeWindow
    if (currentActive && (!previousActive
      || currentActive.bundleId !== previousActive.bundleId
      || currentActive.title !== previousActive.title)) {
      emitter.emit('appSwitch', currentActive, previousActive)
    }
    lastSnapshot = snapshot
  }
  emitter.getLastSnapshot = () => lastSnapshot

  emitter.startPolling = () => {
    if (timer) return
    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)
    timer.unref()
  }

  emitter.stopPolling = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return emitter
}
