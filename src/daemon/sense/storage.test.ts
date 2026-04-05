import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { getStorageBytes, getStats, purgeOldImages, purgeOldCaptures, clearData } from './storage'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-sense-test-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function createSession(id: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)'
  ).run(id, now, now)
}

function createCapture(opts: {
  id?: string
  sessionId: string
  capturedAt?: string
  imagePath?: string
  textContent?: string
}): string {
  const db = getDb()
  const id = opts.id ?? randomUUID()
  const now = opts.capturedAt ?? new Date().toISOString()
  db.prepare(`
    INSERT INTO sense_captures (id, session_id, captured_at, image_path, text_content, text_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'done', ?)
  `).run(id, opts.sessionId, now, opts.imagePath ?? null, opts.textContent ?? null, now)
  return id
}

describe('storage', () => {
  describe('getStorageBytes', () => {
    it('returns 0 when no stills directory exists', () => {
      expect(getStorageBytes()).toBe(0)
    })

    it('counts file sizes in stills directory', () => {
      const stillsDir = join(testDir, 'sense', 'stills', '2026-04-04')
      mkdirSync(stillsDir, { recursive: true })
      writeFileSync(join(stillsDir, 'test.jpg'), Buffer.alloc(1000))
      writeFileSync(join(stillsDir, 'test2.jpg'), Buffer.alloc(2000))

      expect(getStorageBytes()).toBe(3000)
    })
  })

  describe('getStats', () => {
    it('returns zero counts for empty database', () => {
      const stats = getStats()
      expect(stats.captureCount).toBe(0)
      expect(stats.sessionCount).toBe(0)
      expect(stats.oldestCapture).toBeNull()
    })

    it('returns correct counts', () => {
      createSession('s1')
      createCapture({ sessionId: 's1', capturedAt: '2026-04-01T10:00:00Z' })
      createCapture({ sessionId: 's1', capturedAt: '2026-04-02T10:00:00Z' })

      const stats = getStats()
      expect(stats.captureCount).toBe(2)
      expect(stats.sessionCount).toBe(1)
      expect(stats.oldestCapture).toBe('2026-04-01T10:00:00Z')
    })
  })

  describe('purgeOldImages', () => {
    it('purges images older than retention period', () => {
      createSession('s1')
      const stillsDir = join(testDir, 'sense', 'stills', '2026-01-01')
      mkdirSync(stillsDir, { recursive: true })
      const imagePath = join(stillsDir, 'old.jpg')
      writeFileSync(imagePath, Buffer.alloc(100))

      createCapture({
        sessionId: 's1',
        capturedAt: '2026-01-01T10:00:00Z',
        imagePath,
        textContent: 'old text',
      })

      const purged = purgeOldImages(1) // 1 day retention
      expect(purged).toBe(1)
      expect(existsSync(imagePath)).toBe(false)

      // Text content should be preserved
      const db = getDb()
      const row = db.prepare('SELECT text_content, image_path, image_purged_at FROM sense_captures').get() as {
        text_content: string
        image_path: string | null
        image_purged_at: string | null
      }
      expect(row.text_content).toBe('old text')
      expect(row.image_path).toBeNull()
      expect(row.image_purged_at).not.toBeNull()
    })
  })

  describe('clearData', () => {
    it('clears all data', () => {
      createSession('s1')
      createCapture({ sessionId: 's1' })
      createCapture({ sessionId: 's1' })

      const deleted = clearData()
      expect(deleted).toBe(2)

      const stats = getStats()
      expect(stats.captureCount).toBe(0)
      expect(stats.sessionCount).toBe(0)
    })
  })
})
