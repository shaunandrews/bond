import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { getDb } from '../db'
import { createPresenceMonitor } from './presence'
import { createWindowDetector } from './window-detector'
import { createClipboardMonitor } from './clipboard'
import { isBlacklisted, isAmbiguous } from './privacy'
import { createTextWorker } from './worker'
import { runRetentionCleanup } from './storage'
import { getStillsDir, getDateDir } from './storage'
import type { SenseState, SenseSettings, SenseCapture } from '../../shared/sense'
import { DEFAULT_SENSE_SETTINGS } from '../../shared/sense'

export interface SenseController extends EventEmitter {
  on(event: 'stateChanged', listener: (state: SenseState) => void): this
  on(event: 'requestCapture', listener: (payload: { captureDir: string; captureId: string }) => void): this
  emit(event: 'stateChanged', state: SenseState): boolean
  emit(event: 'requestCapture', payload: { captureDir: string; captureId: string }): boolean
  getState(): SenseState
  getSettings(): SenseSettings
  enable(): void
  disable(): void
  pause(minutes?: number): void
  resume(): void
  suspend(): void
  wake(): void
  onCaptureReady(captureId: string, imagePath: string): void
  updateSettings(updates: Partial<SenseSettings>): SenseSettings
  destroy(): void
}

/**
 * Central state machine for Sense.
 * States: disabled → armed → recording → idle → paused → suspended
 *
 * Orchestrates presence monitor, window detector, clipboard monitor,
 * text extraction worker, and capture lifecycle.
 */
export function createSenseController(initialSettings?: Partial<SenseSettings>): SenseController {
  const emitter = new EventEmitter() as SenseController
  let state: SenseState = 'disabled'
  let settings: SenseSettings = { ...DEFAULT_SENSE_SETTINGS, ...initialSettings }
  let currentSessionId: string | null = null

  // Components
  const presence = createPresenceMonitor(settings.idleThresholdSeconds)
  const windowDetector = createWindowDetector()
  const clipboard = createClipboardMonitor()
  const textWorker = createTextWorker(settings)

  // Timers
  let captureTimer: ReturnType<typeof setInterval> | null = null
  let pauseTimer: ReturnType<typeof setTimeout> | null = null
  let retentionTimer: ReturnType<typeof setInterval> | null = null

  // Pending capture (waiting for main process response)
  let pendingCapture: { id: string; preSnapshot: Awaited<ReturnType<typeof windowDetector.getSnapshot>> } | null = null

  function setState(newState: SenseState): void {
    if (newState === state) return
    state = newState
    emitter.emit('stateChanged', state)
  }

  function startSession(): void {
    const db = getDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)'
    ).run(id, now, now)
    currentSessionId = id
  }

  function closeSession(): void {
    if (!currentSessionId) return
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE sense_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL'
    ).run(now, currentSessionId)
    currentSessionId = null
  }

  async function triggerCapture(trigger: SenseCapture['captureTrigger']): Promise<void> {
    if (state !== 'recording' || !currentSessionId) return
    if (pendingCapture) return // already waiting for a capture

    try {
      // Pre-capture window snapshot
      const preSnapshot = await windowDetector.getSnapshot()

      // Blacklist check
      if (isBlacklisted(preSnapshot.windows, settings.blacklistedApps)) return

      // Prepare capture directory
      const dateStr = new Date().toISOString().split('T')[0]
      const captureDir = getDateDir(dateStr)
      mkdirSync(captureDir, { recursive: true })

      // Create capture record
      const db = getDb()
      const captureId = randomUUID()
      const now = new Date().toISOString()
      const activeWindow = preSnapshot.activeWindow

      db.prepare(`
        INSERT INTO sense_captures (
          id, session_id, captured_at, app_name, app_bundle_id, window_title,
          visible_windows, capture_trigger, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        captureId, currentSessionId, now,
        activeWindow?.name ?? null,
        activeWindow?.bundleId ?? null,
        activeWindow?.title ?? null,
        JSON.stringify(preSnapshot.windows.map(w => w.name)),
        trigger ?? null,
        now
      )

      // Increment session capture count
      db.prepare(
        'UPDATE sense_sessions SET capture_count = capture_count + 1 WHERE id = ?'
      ).run(currentSessionId)

      // Store pending state for post-capture check
      pendingCapture = { id: captureId, preSnapshot }

      // Request capture from main process
      emitter.emit('requestCapture', { captureDir, captureId })
    } catch {
      // Silently skip failed captures
      pendingCapture = null
    }
  }

  function startCapturing(): void {
    if (captureTimer) return

    const intervalMs = settings.captureIntervalSeconds * 1000
    captureTimer = setInterval(() => triggerCapture('interval'), intervalMs)
    captureTimer.unref()

    // Initial capture
    triggerCapture('interval')
  }

  function stopCapturing(): void {
    if (captureTimer) {
      clearInterval(captureTimer)
      captureTimer = null
    }
  }

  // --- Presence events ---
  presence.on('change', (presenceState) => {
    if (state === 'disabled' || state === 'paused' || state === 'suspended') return

    if (presenceState === 'active' && state === 'armed') {
      startSession()
      setState('recording')
      startCapturing()
      textWorker.start()
    } else if (presenceState === 'active' && state === 'idle') {
      startSession()
      setState('recording')
      startCapturing()
    } else if (presenceState === 'idle' && state === 'recording') {
      stopCapturing()
      closeSession()
      setState('idle')
    }
  })

  // --- Window switch events (event-driven capture) ---
  windowDetector.on('appSwitch', () => {
    if (state === 'recording' && settings.eventDrivenCapture) {
      triggerCapture('app_switch')
    }
  })

  // --- Clipboard events ---
  clipboard.on('change', () => {
    if (state === 'recording' && settings.clipboardCapture) {
      triggerCapture('clipboard')
    }
  })

  // --- Public API ---

  emitter.getState = () => state
  emitter.getSettings = () => ({ ...settings })

  emitter.enable = () => {
    if (state !== 'disabled') return
    settings.enabled = true
    setState('armed')
    presence.start()
    windowDetector.startPolling()
    if (settings.clipboardCapture) clipboard.start()

    // Start retention cleanup (runs every hour)
    retentionTimer = setInterval(() => {
      runRetentionCleanup(settings.retentionDays, settings.textRetentionDays, settings.storageCapMb)
    }, 60 * 60 * 1000)
    retentionTimer.unref()

    // Ensure stills directory exists
    mkdirSync(getStillsDir(), { recursive: true })

    // Always start the text worker on enable — it processes pending captures
    // from previous sessions even if we're not yet recording
    textWorker.start()

    // If user is already active, start recording immediately.
    // Presence only emits 'change' on transitions — if already active when we start
    // polling, no event fires. Poll a few times to catch the initial state.
    const checkActive = setInterval(() => {
      if (state !== 'armed') { clearInterval(checkActive); return }
      if (presence.getState() === 'active') {
        clearInterval(checkActive)
        startSession()
        setState('recording')
        startCapturing()
        textWorker.start()
      }
    }, 500)
    checkActive.unref()
    // Give up after 10s — presence change events will handle it from there
    setTimeout(() => clearInterval(checkActive), 10_000).unref()
  }

  emitter.disable = () => {
    stopCapturing()
    closeSession()
    textWorker.stop()
    presence.stop()
    windowDetector.stopPolling()
    clipboard.stop()
    if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null }
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null }
    settings.enabled = false
    setState('disabled')
  }

  emitter.pause = (minutes = 10) => {
    if (state !== 'recording' && state !== 'armed' && state !== 'idle') return
    stopCapturing()
    closeSession()
    setState('paused')
    pauseTimer = setTimeout(() => {
      pauseTimer = null
      setState('armed')
      // If user is active, start recording immediately
      if (presence.getState() === 'active') {
        startSession()
        setState('recording')
        startCapturing()
      }
    }, minutes * 60 * 1000)
    pauseTimer.unref()
  }

  emitter.resume = () => {
    if (state !== 'paused') return
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null }
    setState('armed')
    if (presence.getState() === 'active') {
      startSession()
      setState('recording')
      startCapturing()
    }
  }

  emitter.suspend = () => {
    if (state === 'disabled') return
    stopCapturing()
    closeSession()
    textWorker.stop()
    setState('suspended')
  }

  emitter.wake = () => {
    if (state !== 'suspended') return
    textWorker.start()
    setState('armed')
    if (presence.getState() === 'active') {
      startSession()
      setState('recording')
      startCapturing()
    }
  }

  emitter.onCaptureReady = async (captureId: string, imagePath: string) => {
    if (!pendingCapture || pendingCapture.id !== captureId) return

    const { preSnapshot } = pendingCapture
    pendingCapture = null

    try {
      // Post-capture window snapshot
      const postSnapshot = await windowDetector.getSnapshot()

      // Blacklist recheck
      if (isBlacklisted(postSnapshot.windows, settings.blacklistedApps)) {
        // Discard — delete image, remove capture record
        const db = getDb()
        db.prepare('DELETE FROM sense_captures WHERE id = ?').run(captureId)
        try { const { unlinkSync } = await import('node:fs'); unlinkSync(imagePath) } catch { /* ok */ }
        return
      }

      // Ambiguity check
      const ambiguous = isAmbiguous(preSnapshot.activeWindow, postSnapshot.activeWindow)

      // Update capture record with image path and ambiguity
      const db = getDb()
      db.prepare(
        'UPDATE sense_captures SET image_path = ?, ambiguous = ? WHERE id = ?'
      ).run(imagePath, ambiguous ? 1 : 0, captureId)
    } catch {
      // If post-check fails, keep the capture but mark as ambiguous
      const db = getDb()
      db.prepare(
        'UPDATE sense_captures SET image_path = ?, ambiguous = 1 WHERE id = ?'
      ).run(imagePath, captureId)
    }
  }

  emitter.updateSettings = (updates: Partial<SenseSettings>): SenseSettings => {
    settings = { ...settings, ...updates }
    return { ...settings }
  }

  emitter.destroy = () => {
    emitter.disable()
    emitter.removeAllListeners()
  }

  // --- Recovery on startup ---
  // Close stale sessions and re-queue stuck captures
  try {
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE sense_sessions SET ended_at = ? WHERE ended_at IS NULL'
    ).run(now)
    db.prepare(
      "UPDATE sense_captures SET text_status = 'pending' WHERE text_status = 'processing'"
    ).run()
  } catch { /* ignore during init */ }

  return emitter
}
