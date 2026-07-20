import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { createCollection, addItem } from './collections'
import { saveImage } from './images'
import {
  getAsset, listAssets, addDocument, updateAssetMetadata, deleteAsset,
  addReference, removeReference, listReferencesForItem, listBacklinksForAsset,
  getLibraryDir,
} from './library'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-library-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

function createTestSession(id: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO sessions (id, title, summary, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'Test', '', 0, now, now)
}

const TEXT_B64 = Buffer.from('# Catch-up\n\nHello world').toString('base64')

describe('library module', () => {
  describe('addDocument', () => {
    it('writes a file under the library dir and creates an asset row', () => {
      const asset = addDocument({ title: 'Studio catch-up', filename: 'catchup.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

      expect(asset.kind).toBe('document')
      expect(asset.format).toBe('markdown')
      expect(asset.title).toBe('Studio catch-up')
      expect(asset.managedPath.startsWith(getLibraryDir())).toBe(true)
      expect(existsSync(asset.managedPath)).toBe(true)
      expect(asset.previewText).toContain('Catch-up')
    })

    it('defaults title from filename when not given', () => {
      const asset = addDocument({ filename: 'report.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      expect(asset.title).toBe('report')
    })

    it('does not compute preview text for non-text formats', () => {
      const asset = addDocument({ filename: 'doc.pdf', mediaType: 'application/pdf', format: 'pdf', data: TEXT_B64 })
      expect(asset.previewText).toBeUndefined()
    })

    it('records provenance when given', () => {
      createTestSession('s1')
      const asset = addDocument({
        filename: 'catchup.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64,
        sourceSessionId: 's1', sourceUrl: 'https://example.com/report',
      })
      expect(asset.sourceSessionId).toBe('s1')
      expect(asset.sourceUrl).toBe('https://example.com/report')
    })
  })

  describe('getAsset / listAssets', () => {
    it('lists both document and media kinds, newest first', () => {
      createTestSession('s1')
      const doc = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      const img = saveImage('s1', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'image/png')

      const all = listAssets()
      expect(all.map(a => a.id)).toEqual(expect.arrayContaining([doc.id, img.id]))
    })

    it('filters by kind', () => {
      createTestSession('s1')
      addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      saveImage('s1', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'image/png')

      expect(listAssets({ kind: 'document' })).toHaveLength(1)
      expect(listAssets({ kind: 'media' })).toHaveLength(1)
    })

    it('searches title/filename/preview text', () => {
      addDocument({ title: 'Studio catch-up', filename: 'catchup.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      addDocument({ title: 'Unrelated note', filename: 'note.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

      const results = listAssets({ query: 'Studio' })
      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('Studio catch-up')
    })
  })

  describe('updateAssetMetadata', () => {
    it('updates title without touching other fields', () => {
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      const updated = updateAssetMetadata(asset.id, { title: 'Renamed' })
      expect(updated?.title).toBe('Renamed')
      expect(updated?.filename).toBe(asset.filename)
    })
  })

  describe('deleteAsset', () => {
    it('deletes a document asset and its file', () => {
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      expect(deleteAsset(asset.id)).toBe(true)
      expect(getAsset(asset.id)).toBeNull()
      expect(existsSync(asset.managedPath)).toBe(false)
    })

    it('delegates to images.ts for media-kind assets', () => {
      createTestSession('s1')
      const img = saveImage('s1', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'image/png')
      expect(deleteAsset(img.id)).toBe(true)
      expect(getDb().prepare('SELECT * FROM images WHERE id = ?').get(img.id)).toBeUndefined()
      expect(getAsset(img.id)).toBeNull()
    })

    it('returns false for a nonexistent asset', () => {
      expect(deleteAsset('nope')).toBe(false)
    })
  })

  describe('references', () => {
    function setupItem() {
      const collection = createCollection('Tracker', [{ name: 'title', type: 'text', primary: true }])
      const item = addItem(collection.id, { title: 'Studio work' })
      return { collection, item }
    }

    it('adds and lists a reference for an item', () => {
      const { item } = setupItem()
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

      addReference(asset.id, item.id)

      const refs = listReferencesForItem(item.id)
      expect(refs.map(r => r.id)).toEqual([asset.id])
    })

    it('is idempotent — adding the same reference twice does not duplicate', () => {
      const { item } = setupItem()
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

      addReference(asset.id, item.id)
      addReference(asset.id, item.id)

      expect(listReferencesForItem(item.id)).toHaveLength(1)
    })

    it('removing a reference does not delete the asset or affect other references', () => {
      const { collection, item } = setupItem()
      const item2 = addItem(collection.id, { title: 'Other item' })
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

      addReference(asset.id, item.id)
      addReference(asset.id, item2.id)
      expect(removeReference(asset.id, item.id)).toBe(true)

      expect(listReferencesForItem(item.id)).toHaveLength(0)
      expect(listReferencesForItem(item2.id)).toHaveLength(1)
      expect(getAsset(asset.id)).not.toBeNull()
    })

    it('deleting the item cascades its references but leaves the asset intact', () => {
      const { item } = setupItem()
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      addReference(asset.id, item.id)

      getDb().prepare('DELETE FROM collection_items WHERE id = ?').run(item.id)

      expect(getDb().prepare('SELECT * FROM asset_references WHERE item_id = ?').all(item.id)).toHaveLength(0)
      expect(getAsset(asset.id)).not.toBeNull()
    })

    it('deleting the asset cascades its references but leaves the item intact', () => {
      const { item } = setupItem()
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
      addReference(asset.id, item.id)

      deleteAsset(asset.id)

      expect(listReferencesForItem(item.id)).toHaveLength(0)
      expect(getDb().prepare('SELECT * FROM collection_items WHERE id = ?').get(item.id)).toBeTruthy()
    })

    it('lists backlinks for an asset referenced by multiple items', () => {
      const { collection, item } = setupItem()
      const item2 = addItem(collection.id, { title: 'Other item' })
      const asset = addDocument({ filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

      addReference(asset.id, item.id)
      addReference(asset.id, item2.id)

      const backlinks = listBacklinksForAsset(asset.id)
      expect(backlinks).toHaveLength(2)
      expect(backlinks.map(b => b.itemLabel).sort()).toEqual(['Other item', 'Studio work'])
      expect(backlinks.every(b => b.collectionName === 'Tracker')).toBe(true)
    })
  })
})
