import { join } from 'node:path'
import { existsSync, unlinkSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { getDb } from '../db'
import { getDataDir } from '../paths'

/**
 * Returns the base directory for Sense stills.
 */
export function getSenseDir(): string {
  return join(getDataDir(), 'sense')
}

export function getStillsDir(): string {
  return join(getSenseDir(), 'stills')
}

/**
 * Returns the capture directory for a specific date (YYYY-MM-DD).
 */
export function getDateDir(date: string): string {
  return join(getStillsDir(), date)
}

/**
 * Calculate total storage used by Sense (stills on disk + database).
 */
export function getStorageBytes(): number {
  const stillsDir = getStillsDir()
  if (!existsSync(stillsDir)) return 0

  let total = 0
  try {
    for (const dateDir of readdirSync(stillsDir)) {
      const datePath = join(stillsDir, dateDir)
      const stat = statSync(datePath)
      if (!stat.isDirectory()) continue

      for (const file of readdirSync(datePath)) {
        try {
          total += statSync(join(datePath, file)).size
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return total
}

/**
 * Storage stats for display.
 */
export function getStats() {
  const db = getDb()
  const captureCount = (db.prepare('SELECT COUNT(*) as n FROM sense_captures').get() as { n: number }).n
  const sessionCount = (db.prepare('SELECT COUNT(*) as n FROM sense_sessions').get() as { n: number }).n
  const oldest = db.prepare('SELECT MIN(captured_at) as t FROM sense_captures').get() as { t: string | null }

  return {
    storageBytes: getStorageBytes(),
    captureCount,
    sessionCount,
    oldestCapture: oldest.t,
  }
}

/**
 * Purge images older than retentionDays but keep text_content.
 */
export function purgeOldImages(retentionDays: number): number {
  const db = getDb()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString()
  const now = new Date().toISOString()

  const rows = db.prepare(`
    SELECT id, image_path FROM sense_captures
    WHERE captured_at < ? AND image_path IS NOT NULL AND image_purged_at IS NULL
  `).all(cutoffStr) as { id: string; image_path: string }[]

  let purged = 0
  const update = db.prepare(
    'UPDATE sense_captures SET image_path = NULL, image_purged_at = ? WHERE id = ?'
  )

  for (const row of rows) {
    try {
      if (existsSync(row.image_path)) {
        unlinkSync(row.image_path)
      }
      update.run(now, row.id)
      purged++
    } catch { /* skip */ }
  }

  // Clean up empty date directories
  cleanEmptyDirs()

  return purged
}

/**
 * Purge entire capture rows older than textRetentionDays.
 */
export function purgeOldCaptures(textRetentionDays: number): number {
  const db = getDb()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - textRetentionDays)
  const cutoffStr = cutoff.toISOString()

  // Delete images first
  const rows = db.prepare(`
    SELECT image_path FROM sense_captures
    WHERE captured_at < ? AND image_path IS NOT NULL
  `).all(cutoffStr) as { image_path: string }[]

  for (const row of rows) {
    try {
      if (existsSync(row.image_path)) unlinkSync(row.image_path)
    } catch { /* skip */ }
  }

  const result = db.prepare('DELETE FROM sense_captures WHERE captured_at < ?').run(cutoffStr)

  // Clean up empty sessions
  db.prepare(`
    DELETE FROM sense_sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM sense_captures)
  `).run()

  cleanEmptyDirs()

  return result.changes
}

/**
 * Enforce storage cap by purging oldest images first.
 */
export function enforceStorageCap(capMb: number): void {
  const capBytes = capMb * 1024 * 1024
  let currentBytes = getStorageBytes()

  if (currentBytes <= capBytes) return

  const db = getDb()

  // Purge oldest images first
  const rows = db.prepare(`
    SELECT id, image_path FROM sense_captures
    WHERE image_path IS NOT NULL AND image_purged_at IS NULL
    ORDER BY captured_at ASC
  `).all() as { id: string; image_path: string }[]

  const now = new Date().toISOString()
  const update = db.prepare(
    'UPDATE sense_captures SET image_path = NULL, image_purged_at = ? WHERE id = ?'
  )

  for (const row of rows) {
    if (currentBytes <= capBytes) break

    try {
      if (existsSync(row.image_path)) {
        const size = statSync(row.image_path).size
        unlinkSync(row.image_path)
        currentBytes -= size
      }
      update.run(now, row.id)
    } catch { /* skip */ }
  }

  cleanEmptyDirs()
}

/**
 * Clear all Sense data or a specific date range.
 */
export function clearData(range?: { from?: string; to?: string }): number {
  const db = getDb()

  if (!range) {
    // Clear everything
    const rows = db.prepare(
      'SELECT image_path FROM sense_captures WHERE image_path IS NOT NULL'
    ).all() as { image_path: string }[]

    for (const row of rows) {
      try { if (existsSync(row.image_path)) unlinkSync(row.image_path) } catch { /* skip */ }
    }

    const result = db.prepare('DELETE FROM sense_captures').run()
    db.prepare('DELETE FROM sense_sessions').run()
    cleanEmptyDirs()
    return result.changes
  }

  // Date range
  let sql = 'SELECT id, image_path FROM sense_captures WHERE 1=1'
  const params: string[] = []

  if (range.from) {
    sql += ' AND captured_at >= ?'
    params.push(range.from)
  }
  if (range.to) {
    sql += ' AND captured_at <= ?'
    params.push(range.to)
  }

  const rows = db.prepare(sql).all(...params) as { id: string; image_path: string | null }[]

  for (const row of rows) {
    if (row.image_path) {
      try { if (existsSync(row.image_path)) unlinkSync(row.image_path) } catch { /* skip */ }
    }
  }

  const ids = rows.map(r => r.id)
  if (ids.length === 0) return 0

  const placeholders = ids.map(() => '?').join(',')
  const result = db.prepare(`DELETE FROM sense_captures WHERE id IN (${placeholders})`).run(...ids)

  cleanEmptyDirs()
  return result.changes
}

/**
 * Run all retention cleanup tasks.
 */
export function runRetentionCleanup(retentionDays: number, textRetentionDays: number, storageCapMb: number): void {
  purgeOldImages(retentionDays)
  purgeOldCaptures(textRetentionDays)
  enforceStorageCap(storageCapMb)
}

function cleanEmptyDirs(): void {
  const stillsDir = getStillsDir()
  if (!existsSync(stillsDir)) return

  try {
    for (const dateDir of readdirSync(stillsDir)) {
      const datePath = join(stillsDir, dateDir)
      try {
        const stat = statSync(datePath)
        if (!stat.isDirectory()) continue
        const files = readdirSync(datePath)
        if (files.length === 0) {
          rmdirSync(datePath)
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
