import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { AttachedImage, ImageMediaType, ImageRecord } from '../shared/session'
import { getDataDir } from './paths'
import { getDb } from './db'

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

export function getImagesDir(): string {
  return join(getDataDir(), 'images')
}

function ensureImagesDir(): void {
  mkdirSync(getImagesDir(), { recursive: true })
}

export function saveImage(sessionId: string, data: string, mediaType: ImageMediaType): ImageRecord {
  ensureImagesDir()
  const id = randomUUID()
  const ext = MIME_TO_EXT[mediaType] ?? '.png'
  const filename = `${id}${ext}`
  const filePath = join(getImagesDir(), filename)
  const buf = Buffer.from(data, 'base64')

  writeFileSync(filePath, buf)

  const now = new Date().toISOString()
  const db = getDb()
  db.prepare(
    'INSERT INTO images (id, session_id, filename, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, filename, mediaType, buf.length, now)

  return { id, sessionId, filename, mediaType, sizeBytes: buf.length, createdAt: now }
}

export function saveImages(sessionId: string, images: AttachedImage[]): string[] {
  return images.map(img => saveImage(sessionId, img.data, img.mediaType).id)
}

export function getImage(imageId: string): AttachedImage | null {
  const db = getDb()
  const row = db.prepare('SELECT filename, media_type FROM images WHERE id = ?').get(imageId) as
    | { filename: string; media_type: string }
    | undefined
  if (!row) return null

  try {
    const buf = readFileSync(join(getImagesDir(), row.filename))
    return { data: buf.toString('base64'), mediaType: row.media_type as ImageMediaType }
  } catch {
    return null
  }
}

export function getImages(imageIds: string[]): (AttachedImage | null)[] {
  return imageIds.map(id => getImage(id))
}

export function getImagePath(imageId: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT filename FROM images WHERE id = ?').get(imageId) as
    | { filename: string }
    | undefined
  if (!row) return null
  return join(getImagesDir(), row.filename)
}

export function getImagePaths(imageIds: string[]): string[] {
  return imageIds.map(id => getImagePath(id)).filter((p): p is string => p !== null)
}

export function listAllImages(): ImageRecord[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT id, session_id, filename, media_type, size_bytes, created_at FROM images ORDER BY created_at DESC'
  ).all() as { id: string; session_id: string; filename: string; media_type: string; size_bytes: number; created_at: string }[]
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    filename: r.filename,
    mediaType: r.media_type as ImageMediaType,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at
  }))
}

const SCREENSHOTS_SESSION_TITLE = 'Screenshots'

function ensureScreenshotsSession(): string {
  const db = getDb()
  const row = db.prepare("SELECT id FROM sessions WHERE title = ? AND archived = 0 ORDER BY created_at ASC LIMIT 1")
    .get(SCREENSHOTS_SESSION_TITLE) as { id: string } | undefined
  if (row) return row.id

  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)'
  ).run(id, SCREENSHOTS_SESSION_TITLE, 'Auto-created session for screenshots', now, now)
  return id
}

export function importImage(data: string, mediaType: ImageMediaType): ImageRecord {
  const sessionId = ensureScreenshotsSession()
  return saveImage(sessionId, data, mediaType)
}

export function deleteImage(imageId: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT filename FROM images WHERE id = ?').get(imageId) as
    | { filename: string }
    | undefined
  if (!row) return false

  try {
    unlinkSync(join(getImagesDir(), row.filename))
  } catch { /* file may already be gone */ }

  db.prepare('DELETE FROM images WHERE id = ?').run(imageId)
  return true
}

export function deleteSessionImages(sessionId: string): void {
  const db = getDb()
  const rows = db.prepare('SELECT filename FROM images WHERE session_id = ?').all(sessionId) as
    { filename: string }[]

  const dir = getImagesDir()
  for (const row of rows) {
    try {
      unlinkSync(join(dir, row.filename))
    } catch { /* file may already be gone */ }
  }

  db.prepare('DELETE FROM images WHERE session_id = ?').run(sessionId)
}
