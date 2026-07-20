import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { AssetBacklink, AssetFormat, AssetReference, LibraryAddDocumentInput, LibraryAsset, LibraryListFilter } from '../shared/library'
import { getDataDir } from './paths'
import { getDb } from './db'
import { deleteImage } from './images'
import { getCollection, getItem } from './collections'

const PREVIEW_CHARS = 280
const TEXT_FORMATS: AssetFormat[] = ['markdown', 'plaintext']

interface AssetRow {
  id: string
  kind: string
  format: string
  title: string
  filename: string
  media_type: string
  size_bytes: number
  managed_path: string
  source_url: string | null
  source_session_id: string | null
  source_message_id: string | null
  preview_text: string | null
  created_at: string
  updated_at: string
}

const ASSET_COLS = 'id, kind, format, title, filename, media_type, size_bytes, managed_path, source_url, source_session_id, source_message_id, preview_text, created_at, updated_at'

function rowToAsset(r: AssetRow): LibraryAsset {
  return {
    id: r.id,
    kind: r.kind as LibraryAsset['kind'],
    format: r.format as AssetFormat,
    title: r.title,
    filename: r.filename,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    managedPath: r.managed_path,
    sourceUrl: r.source_url ?? undefined,
    sourceSessionId: r.source_session_id ?? undefined,
    sourceMessageId: r.source_message_id ?? undefined,
    previewText: r.preview_text ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getLibraryDir(): string {
  return join(getDataDir(), 'library')
}

function ensureLibraryDir(): void {
  mkdirSync(getLibraryDir(), { recursive: true })
}

export function getAsset(id: string): LibraryAsset | null {
  const db = getDb()
  const row = db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).get(id) as AssetRow | undefined
  return row ? rowToAsset(row) : null
}

export function listAssets(filter: LibraryListFilter = {}): LibraryAsset[] {
  const db = getDb()
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.kind) {
    clauses.push('kind = ?')
    params.push(filter.kind)
  }
  if (filter.query && filter.query.trim()) {
    clauses.push('(title LIKE ? OR filename LIKE ? OR preview_text LIKE ?)')
    const pattern = `%${filter.query.trim()}%`
    params.push(pattern, pattern, pattern)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT ${ASSET_COLS} FROM assets ${where} ORDER BY created_at DESC`).all(...params) as AssetRow[]
  return rows.map(rowToAsset)
}

const FORMAT_TO_EXT: Record<AssetFormat, string> = {
  markdown: '.md',
  plaintext: '.txt',
  pdf: '.pdf',
  html: '.html',
  other: '',
  image: '',
}

export function addDocument(input: LibraryAddDocumentInput): LibraryAsset {
  ensureLibraryDir()
  const id = randomUUID()
  const ext = FORMAT_TO_EXT[input.format] || (input.filename.includes('.') ? input.filename.slice(input.filename.lastIndexOf('.')) : '')
  const filename = `${id}${ext}`
  const buf = Buffer.from(input.data, 'base64')
  const managedPath = join(getLibraryDir(), filename)
  writeFileSync(managedPath, buf)

  const title = input.title?.trim() || input.filename.replace(/\.[^.]+$/, '') || filename
  const previewText = TEXT_FORMATS.includes(input.format)
    ? buf.toString('utf-8').slice(0, PREVIEW_CHARS)
    : null

  const now = new Date().toISOString()
  const db = getDb()
  db.prepare(`
    INSERT INTO assets (id, kind, format, title, filename, media_type, size_bytes, managed_path, source_url, source_session_id, source_message_id, preview_text, created_at, updated_at)
    VALUES (?, 'document', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.format, title, filename, input.mediaType, buf.length, managedPath,
    input.sourceUrl ?? null, input.sourceSessionId ?? null, input.sourceMessageId ?? null,
    previewText, now, now
  )

  return getAsset(id)!
}

export function updateAssetMetadata(id: string, updates: { title?: string; sourceUrl?: string }): LibraryAsset | null {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []
  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
  if (updates.sourceUrl !== undefined) { sets.push('source_url = ?'); values.push(updates.sourceUrl) }
  if (sets.length === 0) return getAsset(id)

  const now = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(now, id)
  db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getAsset(id)
}

/**
 * Media-kind assets delegate entirely to images.ts — that module owns the
 * `images` row and file, and already cleans up its own mirror row in
 * `assets` (which cascades `asset_references`). Document-kind assets own
 * their file directly and are removed here.
 */
export function deleteAsset(id: string): boolean {
  const asset = getAsset(id)
  if (!asset) return false

  if (asset.kind === 'media') {
    return deleteImage(id)
  }

  try {
    unlinkSync(asset.managedPath)
  } catch { /* file may already be gone */ }
  const result = getDb().prepare('DELETE FROM assets WHERE id = ?').run(id) // cascades asset_references
  return result.changes > 0
}

export function addReference(assetId: string, itemId: string): AssetReference {
  const item = getItem(itemId)
  if (!item) throw new Error(`collection item not found: ${itemId}`)
  if (!getAsset(assetId)) throw new Error(`asset not found: ${assetId}`)

  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO asset_references (id, asset_id, collection_id, item_id, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(asset_id, item_id) DO NOTHING
  `).run(id, assetId, item.collectionId, itemId, now)

  const row = db.prepare('SELECT id, asset_id, collection_id, item_id, created_at FROM asset_references WHERE asset_id = ? AND item_id = ?')
    .get(assetId, itemId) as { id: string; asset_id: string; collection_id: string; item_id: string; created_at: string }
  return { id: row.id, assetId: row.asset_id, collectionId: row.collection_id, itemId: row.item_id, createdAt: row.created_at }
}

export function removeReference(assetId: string, itemId: string): boolean {
  const result = getDb().prepare('DELETE FROM asset_references WHERE asset_id = ? AND item_id = ?').run(assetId, itemId)
  return result.changes > 0
}

export function listReferencesForItem(itemId: string): LibraryAsset[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT ${ASSET_COLS.split(', ').map(c => `a.${c}`).join(', ')}
    FROM asset_references ar
    JOIN assets a ON a.id = ar.asset_id
    WHERE ar.item_id = ?
    ORDER BY ar.created_at DESC
  `).all(itemId) as AssetRow[]
  return rows.map(rowToAsset)
}

export function listBacklinksForAsset(assetId: string): AssetBacklink[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT ar.item_id as item_id, c.id as collection_id, c.name as collection_name
    FROM asset_references ar
    JOIN collection_items ci ON ci.id = ar.item_id
    JOIN collections c ON c.id = ci.collection_id
    WHERE ar.asset_id = ?
    ORDER BY ar.created_at DESC
  `).all(assetId) as { item_id: string; collection_id: string; collection_name: string }[]

  return rows.map(row => {
    const item = getItem(row.item_id)
    const collection = getCollection(row.collection_id)
    const primary = collection?.schema.find(f => f.primary)
    const labelValue = primary && item ? item.data[primary.name] : undefined
    const itemLabel = labelValue != null && String(labelValue).trim() ? String(labelValue) : 'Untitled'
    const itemKey = collection?.issuePrefix && item ? `${collection.issuePrefix}-${item.displayNumber}` : null
    return {
      itemId: row.item_id,
      collectionId: row.collection_id,
      collectionName: row.collection_name,
      itemKey,
      itemLabel,
    }
  })
}
