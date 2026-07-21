import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  buildNotePrompt,
  cleanNote,
  gatherEvidence,
  generateReentryNote,
  hasEnoughEvidence,
} from './notes'
import { createBlock, createSegment, createThread, getBlock, linkCapture, updateBlock } from './store'
import type { DeskThread } from '../../shared/desk'

let testDir: string
let studio: DeskThread

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-notes-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  studio = createThread({ name: 'Studio sync dialog', source: 'user' })
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function blockWithEvidence(opts: { paths?: string[]; titles?: string[]; text?: string; minutesAgo?: number } = {}) {
  const block = createBlock({ threadId: studio.id, startedAt: new Date(Date.now() - 3_600_000).toISOString() })
  const segment = createSegment({
    blockId: block.id,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    resourceSignature: 'sig',
    evidence: { appName: 'Studio', paths: opts.paths, titles: opts.titles },
  })
  if (opts.text) {
    const db = getDb()
    const sessionId = randomUUID()
    const captureId = randomUUID()
    const at = new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000).toISOString()
    db.prepare('INSERT INTO sense_sessions (id, started_at, capture_count, created_at) VALUES (?, ?, 0, ?)')
      .run(sessionId, at, at)
    db.prepare(`INSERT INTO sense_captures (id, session_id, captured_at, text_content, text_status, created_at)
      VALUES (?, ?, ?, ?, 'done', ?)`).run(captureId, sessionId, at, opts.text, at)
    linkCapture(segment.id, captureId)
  }
  return block
}

const run = (blockId: string, prompt: (p: string) => Promise<string>) =>
  generateReentryNote(blockId, { prompt: async p => prompt(p) })

describe('gatherEvidence', () => {
  it('collects files, titles, and the last 30 minutes of text', () => {
    const block = blockWithEvidence({
      paths: ['~/dev/bond/src/SyncDialog.tsx'],
      titles: ['Studio — Sync Dialog'],
      text: 'conflict state copy is still unwritten',
    })
    const evidence = gatherEvidence(block.id)

    expect(evidence.threadName).toBe('Studio sync dialog')
    expect(evidence.files).toEqual(['~/dev/bond/src/SyncDialog.tsx'])
    expect(evidence.titles).toEqual(['Studio — Sync Dialog'])
    expect(evidence.excerpts[0]).toContain('conflict state copy')
  })

  it('ignores text older than the 30-minute lookback', () => {
    const block = blockWithEvidence({ text: 'ancient context', minutesAgo: 90 })
    expect(gatherEvidence(block.id).excerpts).toEqual([])
  })

  it('redacts files and titles again — Sense rows are raw', () => {
    const block = blockWithEvidence({
      titles: ['Terminal — export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    })
    const evidence = gatherEvidence(block.id)
    expect(JSON.stringify(evidence)).not.toContain('ghp_abcdefghijklmnop')
  })

  it('redacts the captured text again before it can reach a prompt', () => {
    const block = blockWithEvidence({ text: 'deploy with Bearer abc123def456ghi789jkl' })
    expect(JSON.stringify(gatherEvidence(block.id))).not.toContain('abc123def456ghi789jkl')
  })
})

describe('hasEnoughEvidence', () => {
  it('needs at least one of files, titles, or text', () => {
    expect(hasEnoughEvidence({ threadName: 'x', files: [], titles: [], excerpts: [] })).toBe(false)
    expect(hasEnoughEvidence({ threadName: null, files: ['a.ts'], titles: [], excerpts: [] })).toBe(true)
    expect(hasEnoughEvidence({ threadName: null, files: [], titles: ['w'], excerpts: [] })).toBe(true)
    expect(hasEnoughEvidence({ threadName: null, files: [], titles: [], excerpts: ['t'] })).toBe(true)
  })
})

describe('buildNotePrompt', () => {
  it('asks for orientation, not summary, and shows both failure modes', () => {
    const prompt = buildNotePrompt({
      threadName: 'Studio sync dialog', files: ['SyncDialog.tsx'], titles: [], excerpts: [],
    })
    expect(prompt).toContain('pick it back up')
    expect(prompt).toContain('conflict-state copy unwritten')
    expect(prompt).toContain('Worked on Studio for 40 minutes')
    expect(prompt).toContain('summarizes instead of orienting')
  })

  it('gives the model a way to decline', () => {
    expect(buildNotePrompt({ threadName: null, files: [], titles: [], excerpts: ['x'] }))
      .toContain('UNKNOWN')
  })

  it('omits sections it has no evidence for', () => {
    const prompt = buildNotePrompt({ threadName: null, files: [], titles: [], excerpts: ['some text'] })
    expect(prompt).not.toContain('Files open:')
    expect(prompt).not.toContain('Windows:')
  })
})

describe('cleanNote', () => {
  it('strips quotes, prefixes, and extra lines', () => {
    expect(cleanNote('"Left at SyncDialog.tsx — conflict copy unwritten"'))
      .toBe('Left at SyncDialog.tsx — conflict copy unwritten')
    expect(cleanNote('Note: halfway through the retry logic'))
      .toBe('halfway through the retry logic')
    expect(cleanNote('First line here\nsecond line ignored')).toBe('First line here')
  })

  it('treats UNKNOWN and empty output as no note', () => {
    expect(cleanNote('UNKNOWN')).toBeNull()
    expect(cleanNote('unknown')).toBeNull()
    expect(cleanNote('   ')).toBeNull()
    expect(cleanNote('')).toBeNull()
  })

  it('caps the length so it stays one glanceable line', () => {
    expect(cleanNote('x'.repeat(500))!.length).toBe(140)
  })
})

describe('generateReentryNote', () => {
  it('writes a note and marks it ready', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'], text: 'conflict state copy' })
    const result = await run(block.id, async () => 'Left at SyncDialog.tsx — conflict-state copy unwritten')

    expect(result).toEqual({ status: 'ready', note: 'Left at SyncDialog.tsx — conflict-state copy unwritten' })
    const after = getBlock(block.id)!
    expect(after.reentryNote).toBe('Left at SyncDialog.tsx — conflict-state copy unwritten')
    expect(after.noteStatus).toBe('ready')
  })

  it('never overwrites a note the user edited', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'] })
    updateBlock(block.id, { reentryNote: 'my own words', noteStatus: 'edited' })

    const prompt = vi.fn(async () => 'a generated note')
    expect(await run(block.id, prompt)).toEqual({ status: 'skipped', reason: 'edited' })
    expect(prompt).not.toHaveBeenCalled()
    expect(getBlock(block.id)!.reentryNote).toBe('my own words')
  })

  it('loses to a user edit that lands while the model is thinking', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'] })
    const result = await run(block.id, async () => {
      updateBlock(block.id, { reentryNote: 'typed mid-flight', noteStatus: 'edited' })
      return 'a generated note'
    })

    expect(result).toEqual({ status: 'skipped', reason: 'edited' })
    expect(getBlock(block.id)!.reentryNote).toBe('typed mid-flight')
  })

  it('stores nothing when there is no evidence to write from', async () => {
    const block = createBlock({ threadId: studio.id })
    const prompt = vi.fn(async () => 'invented from nothing')

    expect(await run(block.id, prompt)).toEqual({ status: 'failed', reason: 'no_evidence' })
    expect(prompt).not.toHaveBeenCalled()
    expect(getBlock(block.id)!.reentryNote).toBeNull()
    expect(getBlock(block.id)!.noteStatus).toBe('failed')
  })

  it('stores nothing when the model declines', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'] })
    expect(await run(block.id, async () => 'UNKNOWN')).toEqual({ status: 'failed', reason: 'empty' })
    expect(getBlock(block.id)!.reentryNote).toBeNull()
    expect(getBlock(block.id)!.noteStatus).toBe('failed')
  })

  it('stores nothing when the model call fails', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'] })
    const result = await run(block.id, async () => { throw new Error('provider down') })

    expect(result).toMatchObject({ status: 'failed', reason: 'model_error' })
    expect(getBlock(block.id)!.noteStatus).toBe('failed')
  })

  it('stores nothing when the returned note trips redaction', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'] })
    const result = await run(block.id, async () => 'Billing — card number 4111 1111 1111 1111')

    expect(result).toEqual({ status: 'failed', reason: 'redacted' })
    expect(getBlock(block.id)!.reentryNote).toBeNull()
  })

  it('scrubs a secret out of a returned note rather than persisting it', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'] })
    await run(block.id, async () => 'Left mid-deploy with ghp_abcdefghijklmnopqrstuvwxyz0123456789')

    const note = getBlock(block.id)!.reentryNote!
    expect(note).not.toContain('ghp_abcdefghijklmnop')
    expect(note).toContain('[REDACTED')
  })

  it('skips a block that no longer exists', async () => {
    expect(await run('gone', async () => 'x')).toEqual({ status: 'skipped', reason: 'missing_block' })
  })

  it('never sends a screenshot or image path to the model', async () => {
    const block = blockWithEvidence({ paths: ['SyncDialog.tsx'], text: 'work text' })
    let seen = ''
    await run(block.id, async p => { seen = p; return 'a note' })
    expect(seen).not.toMatch(/\.jpg|\.png|image_path|base64/i)
  })
})
