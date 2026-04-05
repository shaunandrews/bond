import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface ClipboardMonitor extends EventEmitter {
  on(event: 'change', listener: (text: string) => void): this
  emit(event: 'change', text: string): boolean
  getLastText(): string | null
  start(): void
  stop(): void
}

const POLL_INTERVAL_MS = 500

/**
 * Monitors clipboard changes via async pbpaste polling.
 * Emits 'change' when clipboard text changes.
 * Skips single-word entries (too noisy).
 */
export function createClipboardMonitor(): ClipboardMonitor {
  const emitter = new EventEmitter() as ClipboardMonitor
  let lastText: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  function poll(): void {
    execFile('pbpaste', [], { timeout: 2_000, maxBuffer: 1024 * 64 }, (err, stdout) => {
      if (err) return

      const text = stdout.trim()
      if (!text) return

      // Skip single-word entries (too noisy)
      if (!text.includes(' ') && !text.includes('\n')) return

      // Skip if unchanged
      if (text === lastText) return

      lastText = text
      emitter.emit('change', text)
    })
  }

  emitter.getLastText = () => lastText

  emitter.start = () => {
    if (timer) return
    // Read initial clipboard state without emitting
    execFile('pbpaste', [], { timeout: 2_000, maxBuffer: 1024 * 64 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        lastText = stdout.trim()
      }
    })
    timer = setInterval(poll, POLL_INTERVAL_MS)
    timer.unref()
  }

  emitter.stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return emitter
}
