import { getDb } from '../db'
import { extractAccessibilityText } from './accessibility'
import { extractOcrText } from './ocr'
import { redact } from './redaction'
import type { SenseCapture } from '../../shared/sense'

const ACCESSIBILITY_MIN_CHARS = 20
/**
 * How long an app stays pinned to OCR before accessibility is re-probed. The
 * old cache was a **sticky one-way downgrade**: a single sub-20-char AX return
 * pinned an app to OCR forever, and nothing ever set it back — which is a large
 * part of why the store was 24,772 OCR captures to 191 accessibility ones.
 * Making the downgrade expire gives AX a way back (an app updates, a window that
 * happened to be empty fills in).
 */
const OCR_PREFERENCE_TTL_DAYS = 7

interface ExtractionResult {
  text: string | null      // null = drop frame (redaction)
  source: SenseCapture['textSource']
  /** Focused-window URL (accessibility only), for Desk's strongest project token. */
  url?: string | null
}

/** Browser-family apps (incl. Electron shells), where a focused URL may exist. */
function isBrowserBundle(bundleId: string | undefined): boolean {
  if (!bundleId) return false
  const b = bundleId.toLowerCase()
  return /chrome|safari|firefox|edge|brave|arc|electron|vivaldi|opera/.test(b)
}

/**
 * Routes text extraction through accessibility or OCR based on per-app quality cache.
 * Tries accessibility first for native apps; falls back to OCR for sparse results.
 * Updates the quality cache after each extraction.
 */
export async function extractText(
  capture: { imagePath?: string; appBundleId?: string; pid?: number },
  preference: 'auto' | 'accessibility' | 'ocr' = 'auto'
): Promise<ExtractionResult> {
  const { imagePath, appBundleId, pid } = capture

  // Determine preferred source
  let useAccessibility = preference !== 'ocr' && !!pid
  let useOcr = preference !== 'accessibility' && !!imagePath

  if (preference === 'auto' && appBundleId) {
    const cached = getAppQuality(appBundleId)
    if (cached === 'ocr') {
      useAccessibility = false
    }
  }

  let accessibilityText: string | null = null
  let ocrText: string | null = null
  let url: string | null = null

  // Try accessibility first
  if (useAccessibility && pid) {
    // Only request the URL from browser-family apps — it is where a URL exists,
    // and the AXManualAccessibility signal it needs has side effects elsewhere.
    const result = await extractAccessibilityText(pid, 10, { wantUrl: isBrowserBundle(appBundleId) })
    if (result) {
      // The focused URL is worth capturing even when the text is sparse — a
      // browser tab is often mostly image with a single strong URL.
      url = result.url ?? null
    }
    if (result && result.elements.length > 0) {
      accessibilityText = result.elements.map(e => e.value).join('\n')

      // Update quality cache
      if (appBundleId) {
        updateAppQuality(appBundleId, accessibilityText.length)
      }

      // If sparse, fall back to OCR
      if (accessibilityText.length < ACCESSIBILITY_MIN_CHARS) {
        accessibilityText = null
        if (appBundleId) {
          setAppPreferred(appBundleId, 'ocr')
        }
      }
    }
  }

  // OCR fallback (or primary if accessibility skipped/failed)
  if (!accessibilityText && useOcr && imagePath) {
    const result = await extractOcrText(imagePath)
    if (result && result.lines.length > 0) {
      ocrText = result.lines.join('\n')
    }
  }

  // Combine results
  let rawText: string | null = null
  let source: SenseCapture['textSource'] = 'failed'

  if (accessibilityText && ocrText) {
    rawText = accessibilityText + '\n---\n' + ocrText
    source = 'both'
  } else if (accessibilityText) {
    rawText = accessibilityText
    source = 'accessibility'
  } else if (ocrText) {
    rawText = ocrText
    source = 'ocr'
  }

  if (!rawText) {
    return { text: null, source: 'failed', url }
  }

  // Redact sensitive content
  const redacted = redact(rawText)
  return { text: redacted, source, url }
}

// --- App quality cache (SQLite-backed) ---

function getAppQuality(bundleId: string): 'accessibility' | 'ocr' | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT preferred_source, updated_at FROM sense_app_text_quality WHERE bundle_id = ?'
  ).get(bundleId) as { preferred_source: string; updated_at: string } | undefined
  if (!row) return null

  // An OCR downgrade expires: past the TTL, forget it so accessibility is
  // re-probed rather than pinned to OCR for the life of the database.
  if (row.preferred_source === 'ocr') {
    const ageMs = Date.now() - Date.parse(row.updated_at)
    if (Number.isFinite(ageMs) && ageMs > OCR_PREFERENCE_TTL_DAYS * 86_400_000) return null
  }
  return row.preferred_source as 'accessibility' | 'ocr'
}

function updateAppQuality(bundleId: string, chars: number): void {
  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO sense_app_text_quality (bundle_id, preferred_source, avg_accessibility_chars, sample_count, updated_at)
    VALUES (?, 'accessibility', ?, 1, ?)
    ON CONFLICT(bundle_id) DO UPDATE SET
      avg_accessibility_chars = (avg_accessibility_chars * sample_count + ?) / (sample_count + 1),
      sample_count = sample_count + 1,
      updated_at = ?
  `).run(bundleId, chars, now, chars, now)
}

function setAppPreferred(bundleId: string, source: 'accessibility' | 'ocr'): void {
  const db = getDb()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO sense_app_text_quality (bundle_id, preferred_source, avg_accessibility_chars, sample_count, updated_at)
    VALUES (?, ?, 0, 1, ?)
    ON CONFLICT(bundle_id) DO UPDATE SET
      preferred_source = ?,
      updated_at = ?
  `).run(bundleId, source, now, source, now)
}
