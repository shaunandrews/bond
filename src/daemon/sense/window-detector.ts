import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { DetectedWindow } from '../../shared/sense'
import { resolveHelperPath } from './helpers'

export interface WindowSnapshot {
  windows: DetectedWindow[]
  activeWindow: DetectedWindow | null
  timestamp: string
}

export interface WindowDetector extends EventEmitter {
  on(event: 'appSwitch', listener: (current: DetectedWindow, previous: DetectedWindow | null) => void): this
  emit(event: 'appSwitch', current: DetectedWindow, previous: DetectedWindow | null): boolean
  getSnapshot(): Promise<WindowSnapshot>
  getLastSnapshot(): WindowSnapshot | null
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

  emitter.getSnapshot = () => capture()
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
