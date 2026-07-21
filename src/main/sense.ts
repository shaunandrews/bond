/**
 * Sense capture coordinator for the Electron main process.
 *
 * Listens for sense.requestCapture notifications from the daemon,
 * captures screenshots via desktopCapturer, and calls sense.captureReady
 * back to the daemon.
 *
 * Also handles permission checks and powerMonitor event forwarding.
 */

import { desktopCapturer, screen, systemPreferences, powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BondClient } from '../shared/client'
import type { DetectedWindow } from '../shared/sense'
import { resolveHelperPath } from '../daemon/sense/helpers'

const JPEG_QUALITY = 90 // 0-100, passed to NativeImage.toJPEG()
const CAPTURE_SCALE = 0.75 // Three-quarter resolution

let cleanupFns: (() => void)[] = []

/**
 * Initialize Sense in the main process.
 * Sets up capture request listener and powerMonitor forwarding.
 */
export function initSense(client: BondClient): void {
  // Listen for capture requests from the daemon
  const unsubCapture = client.onSenseRequestCapture(async (payload) => {
    const { captureDir, captureId } = payload

    // Every path out of here must answer the daemon. A silent return leaves
    // `pendingCapture` set forever and the controller refuses every subsequent
    // capture — one lost screenshot would otherwise end the recording day.
    try {
      const imagePath = await captureScreen(captureDir)
      if (imagePath) {
        await client.senseCaptureReady(captureId, imagePath)
      } else {
        await client.senseCaptureFailed(captureId, 'no_screen_source')
      }
    } catch (err) {
      console.error('[Sense] Capture failed:', err)
      try {
        await client.senseCaptureFailed(captureId, err instanceof Error ? err.message : 'capture_error')
      } catch (reportErr) {
        console.error('[Sense] Could not report capture failure:', reportErr)
      }
    }
  })
  cleanupFns.push(unsubCapture)
  startWindowPolling(client)

  // Power monitor events — the daemon's presence monitor handles idle detection
  // via ioreg naturally, so system sleep/wake is detected as extended idle time.
  // No explicit forwarding needed for v1.
}

/**
 * Window titles require Screen Recording permission, and the daemon does not
 * have it: `bin/bond start` runs it under launchd as bare node, where
 * `kCGWindowName` returns an EMPTY STRING for every other app's window. The
 * daemon used to inherit the grant because Electron spawned it; under launchd
 * supervision it does not.
 *
 * The effect is severe rather than cosmetic — with no titles, every window of
 * an app collapses into one resource, so two dev Electron apps (say Bond and
 * Studio) become literally indistinguishable, and so does every terminal tab.
 *
 * Main has the grant, so main reads the windows and pushes them over. Same
 * shape as the screenshot round-trip that already exists.
 */
const WINDOW_POLL_MS = 2_000
const WINDOW_HELPER_TIMEOUT_MS = 3_000

function readWindows(): Promise<DetectedWindow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveHelperPath('bond-window-helper'),
      ['--json', '--min-visible-area', '3000'],
      { timeout: WINDOW_HELPER_TIMEOUT_MS },
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

function startWindowPolling(client: BondClient): void {
  let inFlight = false
  const timer = setInterval(async () => {
    if (inFlight) return // never stack spawns
    inFlight = true
    try {
      await client.senseWindows(await readWindows())
    } catch {
      // A failed poll is not worth logging every two seconds; the daemon falls
      // back to spawning the helper itself once the push goes stale.
    } finally {
      inFlight = false
    }
  }, WINDOW_POLL_MS)
  timer.unref?.()
  cleanupFns.push(() => clearInterval(timer))
}

/**
 * Capture a screenshot of the display under the cursor.
 * Returns the file path of the saved JPEG, or null on failure.
 */
async function captureScreen(captureDir: string): Promise<string | null> {
  // Find the display under the cursor
  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)

  // Calculate thumbnail size at half resolution
  const thumbWidth = Math.round(display.size.width * CAPTURE_SCALE)
  const thumbHeight = Math.round(display.size.height * CAPTURE_SCALE)

  // Get screen sources with thumbnails
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbWidth, height: thumbHeight },
  })

  if (sources.length === 0) return null

  // Find the source matching our display
  // desktopCapturer returns display IDs as strings like "screen:0:0"
  const displayIdStr = String(display.id)
  const source = sources.find(s => s.display_id === displayIdStr) ?? sources[0]

  const thumbnail = source.thumbnail
  if (thumbnail.isEmpty()) return null

  // Encode as JPEG
  const jpegBuffer = thumbnail.toJPEG(JPEG_QUALITY)

  // Save to file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${timestamp}.jpg`
  const imagePath = join(captureDir, filename)

  writeFileSync(imagePath, jpegBuffer)

  return imagePath
}

/**
 * Check if Screen Recording permission is granted.
 */
export function hasScreenRecordingPermission(): boolean {
  return systemPreferences.getMediaAccessStatus('screen') === 'granted'
}

/**
 * Clean up Sense listeners.
 */
export function destroySense(): void {
  for (const fn of cleanupFns) fn()
  cleanupFns = []
}
