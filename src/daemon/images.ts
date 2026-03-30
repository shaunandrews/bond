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
