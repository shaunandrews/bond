import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { saveImage, saveImages, getImage, getImages, getImagePath, getImagePaths, deleteSessionImages, getImagesDir } from './images'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  // Initialize the database (creates schema + tables)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

// Create a test session in the DB
function createTestSession(id: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'Test', '', 0, now, now)
}

// A tiny 1x1 red PNG as base64
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

describe('images module', () => {
  describe('saveImage', () => {
    it('writes file and creates DB row', () => {
      createTestSession('s1')
      const record = saveImage('s1', TINY_PNG, 'image/png')

      expect(record.id).toBeTruthy()
      expect(record.sessionId).toBe('s1')
      expect(record.filename).toMatch(/\.png$/)
      expect(record.mediaType).toBe('image/png')
      expect(record.sizeBytes).toBeGreaterThan(0)

      // File exists on disk
      const filePath = join(getImagesDir(), record.filename)
      expect(existsSync(filePath)).toBe(true)

      // DB row exists
      const db = getDb()
      const row = db.prepare('SELECT * FROM images WHERE id = ?').get(record.id) as any
      expect(row).toBeTruthy()
      expect(row.session_id).toBe('s1')
    })

    it('uses correct extension for media type', () => {
      createTestSession('s1')
      const jpg = saveImage('s1', TINY_PNG, 'image/jpeg')
      expect(jpg.filename).toMatch(/\.jpg$/)

      const webp = saveImage('s1', TINY_PNG, 'image/webp')
      expect(webp.filename).toMatch(/\.webp$/)
    })
  })

  describe('saveImages', () => {
    it('returns array of IDs', () => {
      createTestSession('s1')
      const ids = saveImages('s1', [
        { data: TINY_PNG, mediaType: 'image/png' },
        { data: TINY_PNG, mediaType: 'image/jpeg' },
      ])

      expect(ids).toHaveLength(2)
      expect(typeof ids[0]).toBe('string')
      expect(typeof ids[1]).toBe('string')
    })
  })

  describe('getImage', () => {
    it('reads back saved image as base64', () => {
      createTestSession('s1')
      const record = saveImage('s1', TINY_PNG, 'image/png')
      const result = getImage(record.id)

      expect(result).not.toBeNull()
      expect(result!.data).toBe(TINY_PNG)
      expect(result!.mediaType).toBe('image/png')
    })

    it('returns null for nonexistent ID', () => {
      expect(getImage('does-not-exist')).toBeNull()
    })
  })

  describe('getImages', () => {
    it('returns images in order', () => {
      createTestSession('s1')
      const ids = saveImages('s1', [
        { data: TINY_PNG, mediaType: 'image/png' },
        { data: TINY_PNG, mediaType: 'image/jpeg' },
      ])
      const results = getImages(ids)

      expect(results).toHaveLength(2)
      expect(results[0]!.mediaType).toBe('image/png')
      expect(results[1]!.mediaType).toBe('image/jpeg')
    })

    it('returns null for missing entries', () => {
      const results = getImages(['no-such-id'])
      expect(results).toEqual([null])
    })
  })

  describe('getImagePath / getImagePaths', () => {
    it('returns full file path', () => {
      createTestSession('s1')
      const record = saveImage('s1', TINY_PNG, 'image/png')
      const path = getImagePath(record.id)

      expect(path).toBe(join(getImagesDir(), record.filename))
      expect(existsSync(path!)).toBe(true)
    })

    it('returns null for nonexistent ID', () => {
      expect(getImagePath('nope')).toBeNull()
    })

    it('batch version filters nulls', () => {
      createTestSession('s1')
      const record = saveImage('s1', TINY_PNG, 'image/png')
      const paths = getImagePaths([record.id, 'missing-id'])

      expect(paths).toHaveLength(1)
      expect(paths[0]).toContain(record.filename)
    })
  })

  describe('deleteSessionImages', () => {
    it('removes files and DB rows', () => {
      createTestSession('s1')
      const ids = saveImages('s1', [
        { data: TINY_PNG, mediaType: 'image/png' },
        { data: TINY_PNG, mediaType: 'image/png' },
      ])

      // Verify they exist
      expect(getImage(ids[0])).not.toBeNull()
      expect(getImage(ids[1])).not.toBeNull()

      deleteSessionImages('s1')

      // Files gone
      expect(getImage(ids[0])).toBeNull()
      expect(getImage(ids[1])).toBeNull()

      // DB rows gone
      const db = getDb()
      const count = db.prepare('SELECT COUNT(*) as n FROM images WHERE session_id = ?').get('s1') as { n: number }
      expect(count.n).toBe(0)
    })

    it('does not affect other sessions', () => {
      createTestSession('s1')
      createTestSession('s2')
      saveImages('s1', [{ data: TINY_PNG, mediaType: 'image/png' }])
      const s2Ids = saveImages('s2', [{ data: TINY_PNG, mediaType: 'image/png' }])

      deleteSessionImages('s1')

      expect(getImage(s2Ids[0])).not.toBeNull()
    })
  })
})
