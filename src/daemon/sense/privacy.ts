import type { DetectedWindow } from '../../shared/sense'
import { DEFAULT_BLACKLISTED_APPS } from '../../shared/sense'

/**
 * Checks whether any visible windows belong to blacklisted apps.
 * Used both before and after capture — if any blacklisted app is visible
 * in either snapshot, the frame is discarded.
 */
export function isBlacklisted(
  windows: DetectedWindow[],
  blacklist: string[]
): boolean {
  const fullBlacklist = new Set([...DEFAULT_BLACKLISTED_APPS, ...blacklist])

  for (const win of windows) {
    // Check by bundle ID
    if (win.bundleId && fullBlacklist.has(win.bundleId)) return true

    // Check by window title for private browsing (best-effort)
    const title = win.title.toLowerCase()
    if (
      title.includes('private browsing') ||
      title.includes('incognito') ||
      title.includes('private window')
    ) {
      return true
    }
  }

  return false
}

/**
 * Checks whether the active window changed between two snapshots.
 * If so, the capture is "ambiguous" — it may have captured a transitional frame.
 */
export function isAmbiguous(
  pre: DetectedWindow | null,
  post: DetectedWindow | null
): boolean {
  if (!pre || !post) return false
  return pre.bundleId !== post.bundleId || pre.pid !== post.pid
}
