import { getDb } from '../db'
import { extractText } from './text-router'
import type { SenseSettings } from '../../shared/sense'

import type Database from 'better-sqlite3'

const BATCH_SIZE = 4
const POLL_INTERVAL_MS = 2_000

/**
 * Update text_content with FTS5 error resilience.
 * If the FTS5 trigger fails (corrupt index), disable triggers and update directly.
 */
function safeUpdateText(
  db: ReturnType<typeof getDb>,
  captureId: string,
  text: string,
  status: string,
  source: string
): void {
  try {
    db.prepare(
      'UPDATE sense_captures SET text_status = ?, text_source = ?, text_content = ? WHERE id = ?'
    ).run(status, source, text, captureId)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('malformed') || msg.includes('CORRUPT')) {
      // FTS5 trigger is corrupt — drop triggers and retry
      console.warn('[sense/worker] FTS5 corrupt, disabling triggers and retrying')
      try {
        db.exec('DROP TRIGGER IF EXISTS sense_fts_insert')
        db.exec('DROP TRIGGER IF EXISTS sense_fts_update')
        db.exec('DROP TRIGGER IF EXISTS sense_fts_delete')
        db.exec('DROP TABLE IF EXISTS sense_fts')
      } catch { /* best effort */ }
      // Retry without triggers
      db.prepare(
        'UPDATE sense_captures SET text_status = ?, text_source = ?, text_content = ? WHERE id = ?'
      ).run(status, source, text, captureId)
    } else {
      throw e
    }
  }
}

/**
 * Queue-based text extraction worker.
 * Polls for captures with text_status='pending', extracts text, updates DB.
 */
export function createTextWorker(settings: SenseSettings) {
  let timer: ReturnType<typeof setInterval> | null = null
  let processing = false

  async function processBatch(): Promise<void> {
    if (processing) return
    processing = true

    try {
      const db = getDb()
      console.log('[sense/worker] Processing batch...')

      // Find pending captures
      const pending = db.prepare(`
        SELECT id, session_id, image_path, app_bundle_id, captured_at
        FROM sense_captures
        WHERE text_status = 'pending' AND image_path IS NOT NULL
        ORDER BY captured_at ASC
        LIMIT ?
      `).all(BATCH_SIZE) as {
        id: string
        session_id: string
        image_path: string
        app_bundle_id: string | null
        captured_at: string
      }[]

      if (pending.length === 0) return

      // Mark as processing
      const markProcessing = db.prepare(
        "UPDATE sense_captures SET text_status = 'processing' WHERE id = ?"
      )
      for (const row of pending) {
        markProcessing.run(row.id)
      }

      // Process each capture
      for (const row of pending) {
        try {
          const result = await extractText(
            { imagePath: row.image_path, appBundleId: row.app_bundle_id ?? undefined },
            settings.textExtractionPreference
          )

          if (result.text === null && result.source !== 'failed') {
            // Frame dropped by redaction — delete image and mark failed
            safeUpdateText(db, row.id, '[DROPPED: sensitive content]', 'failed', result.source)
          } else if (result.text) {
            safeUpdateText(db, row.id, result.text, 'done', result.source)
          } else {
            db.prepare(
              "UPDATE sense_captures SET text_status = 'failed', text_source = 'failed' WHERE id = ?"
            ).run(row.id)
          }
        } catch (e) {
          console.error(`[sense/worker] Text extraction error for ${row.id}:`, e)
          db.prepare(
            "UPDATE sense_captures SET text_status = 'failed', text_source = 'failed' WHERE id = ?"
          ).run(row.id)
        }
      }
    } finally {
      processing = false
    }
  }

  /** Re-queue captures stuck in 'processing' (from a crash/restart) */
  function requeueStale(): void {
    const db = getDb()
    db.prepare(
      "UPDATE sense_captures SET text_status = 'pending' WHERE text_status = 'processing'"
    ).run()
  }

  return {
    start(): void {
      requeueStale()
      if (timer) return
      console.log('[sense/worker] Starting text extraction worker')
      timer = setInterval(processBatch, POLL_INTERVAL_MS)
      timer.unref()
      // Process immediately
      processBatch()
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    /** Process pending captures immediately (for testing or manual trigger) */
    processNow: processBatch,
  }
}
