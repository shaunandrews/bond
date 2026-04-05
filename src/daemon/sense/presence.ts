import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'

export type PresenceState = 'active' | 'idle'

export interface PresenceMonitor extends EventEmitter {
  on(event: 'change', listener: (state: PresenceState) => void): this
  emit(event: 'change', state: PresenceState): boolean
  getState(): PresenceState
  getIdleSeconds(): number
  start(): void
  stop(): void
}

const POLL_INTERVAL_MS = 5_000

/**
 * Monitors user presence via macOS idle time (ioreg -c IOHIDSystem).
 * Emits 'change' when transitioning between active and idle.
 */
export function createPresenceMonitor(idleThresholdSeconds: number): PresenceMonitor {
  const emitter = new EventEmitter() as PresenceMonitor
  let state: PresenceState = 'active'
  let idleSeconds = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function pollIdleTime(): void {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], (err, stdout) => {
      if (err) return

      // Parse HIDIdleTime from ioreg output (value in nanoseconds)
      const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/)
      if (!match) return

      const idleNano = parseInt(match[1], 10)
      idleSeconds = idleNano / 1_000_000_000

      const newState: PresenceState = idleSeconds >= idleThresholdSeconds ? 'idle' : 'active'

      if (newState !== state) {
        state = newState
        emitter.emit('change', state)
      }
    })
  }

  emitter.getState = () => state
  emitter.getIdleSeconds = () => idleSeconds

  emitter.start = () => {
    if (timer) return
    pollIdleTime()
    timer = setInterval(pollIdleTime, POLL_INTERVAL_MS)
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
