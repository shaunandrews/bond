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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BondClient } from '../shared/client'

const JPEG_QUALITY = 80 // 0-100, passed to NativeImage.toJPEG()
const CAPTURE_SCALE = 0.5 // Half resolution

let cleanupFns: (() => void)[] = []

/**
 * Initialize Sense in the main process.
 * Sets up capture request listener and powerMonitor forwarding.
 */
export function initSense(client: BondClient): void {
  // Listen for capture requests from the daemon
  const unsubCapture = client.onSenseRequestCapture(async (payload) => {
    const { captureDir, captureId } = payload

    try {
      const imagePath = await captureScreen(captureDir)
      if (imagePath) {
        await client.senseCaptureReady(captureId, imagePath)
      }
    } catch (err) {
      console.error('[Sense] Capture failed:', err)
    }
  })
  cleanupFns.push(unsubCapture)

  // Power monitor events — the daemon's presence monitor handles idle detection
  // via ioreg naturally, so system sleep/wake is detected as extended idle time.
  // No explicit forwarding needed for v1.
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
