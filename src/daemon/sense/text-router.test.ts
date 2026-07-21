import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'

const extractAccessibilityText = vi.hoisted(() => vi.fn())
const extractOcrText = vi.hoisted(() => vi.fn())

vi.mock('./accessibility', () => ({ extractAccessibilityText }))
vi.mock('./ocr', () => ({ extractOcrText }))

import { extractText } from './text-router'

let testDir: string

function axResult(text: string) {
  return { elements: [{ type: 'text', value: text, depth: 1 }] }
}

beforeEach(() => {
  testDir = join(tmpdir(), `bond-text-router-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  extractAccessibilityText.mockReset()
  extractOcrText.mockReset()
  extractOcrText.mockResolvedValue({ lines: ['ocr text from the screenshot'] })
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('extractText — accessibility routing', () => {
  it('reaches the accessibility path when a pid is present', async () => {
    extractAccessibilityText.mockResolvedValue(axResult('a structured accessibility tree dump'))

    const result = await extractText({
      imagePath: '/tmp/shot.jpg',
      appBundleId: 'com.automattic.studio',
      pid: 4242,
    })

    expect(extractAccessibilityText).toHaveBeenCalledWith(4242)
    expect(result.source).toBe('accessibility')
    expect(result.text).toContain('structured accessibility tree')
    // Accessibility won outright, so OCR never ran
    expect(extractOcrText).not.toHaveBeenCalled()
  })

  it('never reaches the accessibility path without a pid — the pre-fix behaviour', async () => {
    const result = await extractText({ imagePath: '/tmp/shot.jpg', appBundleId: 'com.automattic.studio' })

    expect(extractAccessibilityText).not.toHaveBeenCalled()
    expect(result.source).toBe('ocr')
  })

  it('falls back to OCR when the accessibility tree is too sparse', async () => {
    extractAccessibilityText.mockResolvedValue(axResult('tiny'))

    const result = await extractText({ imagePath: '/tmp/shot.jpg', appBundleId: 'com.apple.Safari', pid: 99 })

    expect(extractAccessibilityText).toHaveBeenCalledWith(99)
    expect(result.source).toBe('ocr')

    // and it remembers to skip accessibility for that app next time
    const row = getDb()
      .prepare('SELECT preferred_source FROM sense_app_text_quality WHERE bundle_id = ?')
      .get('com.apple.Safari') as { preferred_source: string } | undefined
    expect(row?.preferred_source).toBe('ocr')
  })

  it('honours the cached per-app ocr preference and skips accessibility', async () => {
    getDb()
      .prepare(
        `INSERT INTO sense_app_text_quality (bundle_id, preferred_source, avg_accessibility_chars, sample_count, updated_at)
         VALUES (?, 'ocr', 0, 1, ?)`
      )
      .run('com.apple.Safari', new Date().toISOString())

    const result = await extractText({ imagePath: '/tmp/shot.jpg', appBundleId: 'com.apple.Safari', pid: 99 })

    expect(extractAccessibilityText).not.toHaveBeenCalled()
    expect(result.source).toBe('ocr')
  })

  it('respects an explicit ocr preference even with a pid', async () => {
    await extractText({ imagePath: '/tmp/shot.jpg', appBundleId: 'com.automattic.studio', pid: 4242 }, 'ocr')
    expect(extractAccessibilityText).not.toHaveBeenCalled()
  })

  it('reports failure when neither source produces text', async () => {
    extractAccessibilityText.mockResolvedValue(null)
    extractOcrText.mockResolvedValue({ lines: [] })

    const result = await extractText({ imagePath: '/tmp/shot.jpg', pid: 4242 })
    expect(result).toEqual({ text: null, source: 'failed' })
  })
})
