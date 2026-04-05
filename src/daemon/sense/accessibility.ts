import { execFile } from 'node:child_process'
import type { AccessibilityResult } from '../../shared/sense'
import { resolveHelperPath } from './helpers'

/**
 * Extracts text from an app's accessibility tree via bond-accessibility-helper.
 * Returns null if accessibility permission is not granted.
 */
export function extractAccessibilityText(
  pid: number,
  maxDepth = 10
): Promise<AccessibilityResult | null> {
  const helperPath = resolveHelperPath('bond-accessibility-helper')

  return new Promise((resolve) => {
    execFile(helperPath, [
      '--pid', String(pid),
      '--max-depth', String(maxDepth),
    ], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }

      try {
        const result = JSON.parse(stdout.trim()) as AccessibilityResult & { error?: string }

        // Check for permission error
        if (result.error === 'accessibility_not_trusted') {
          resolve(null)
          return
        }

        resolve(result)
      } catch {
        resolve(null)
      }
    })
  })
}
