import { execFile } from 'node:child_process'
import type { AccessibilityResult } from '../../shared/sense'
import { resolveHelperPath } from './helpers'

/**
 * Extracts text from an app's accessibility tree via bond-accessibility-helper.
 * Returns null if accessibility permission is not granted.
 */
export function extractAccessibilityText(
  pid: number,
  maxDepth = 10,
  opts: { wantUrl?: boolean } = {}
): Promise<AccessibilityResult | null> {
  const helperPath = resolveHelperPath('bond-accessibility-helper')
  const args = ['--pid', String(pid), '--max-depth', String(maxDepth)]
  if (opts.wantUrl) args.push('--url')

  return new Promise((resolve) => {
    execFile(helperPath, args, { timeout: 10_000 }, (err, stdout) => {
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
