import { execFile } from 'node:child_process'
import type { OcrResult } from '../../shared/sense'
import { resolveHelperPath } from './helpers'

/** Max parallel OCR processes to limit CPU usage */
let activeCount = 0
const MAX_PARALLEL = 2

/**
 * Extracts text from an image via bond-ocr-helper (Apple Vision).
 * Limits concurrent OCR processes to MAX_PARALLEL.
 */
export async function extractOcrText(
  imagePath: string,
  level: 'accurate' | 'fast' = 'accurate'
): Promise<OcrResult | null> {
  // Wait for a slot if at max parallelism
  while (activeCount >= MAX_PARALLEL) {
    await new Promise(r => setTimeout(r, 200))
  }

  activeCount++

  try {
    return await new Promise((resolve) => {
      const helperPath = resolveHelperPath('bond-ocr-helper')

      execFile(helperPath, [
        '--image', imagePath,
        '--level', level,
      ], { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[sense/ocr] Failed: ${err.message}${stderr ? ` stderr: ${stderr}` : ''} (helper: ${helperPath})`)
          resolve(null)
          return
        }

        try {
          const result = JSON.parse(stdout.trim()) as OcrResult
          resolve(result)
        } catch {
          resolve(null)
        }
      })
    })
  } finally {
    activeCount--
  }
}
