import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import {
  attributeSegment,
  bumpRulesVersion,
  createSegment,
  createThread,
  getSegment,
  getRulesVersion,
} from './store'
import { confirmMatcher, writeInferredMatcher } from './matchers'
import { deriveAttribution, getLabelBySource, recordLabel, rederiveStale } from './labels'
import type { DeskEvidence, DeskThread } from '../../shared/desk'

let testDir: string
let studio: DeskThread
let isp: DeskThread

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-labels-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  studio = createThread({ name: 'Studio', source: 'user' })
  isp = createThread({ name: 'ISP problem', source: 'user' })
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function seg(signature = 'sig', evidence: DeskEvidence = { titles: ['studio sync'] }) {
  return createSegment({ blockId: null, startedAt: '2026-07-20T10:00:00.000Z', resourceSignature: signature, evidence })
}

describe('the derivation authority order', () => {
  it('a user label is frozen — it wins over any matcher and is never re-derived', () => {
    const s = seg()
    confirmMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: isp.id })
    recordLabel({ segmentId: s.id, threadId: studio.id, source: 'user', confidence: 1 })

    const r = deriveAttribution(getSegment(s.id)!)
    expect(r.source).toBe('user')
    expect(r.threadId).toBe(studio.id) // NOT isp, despite the confirmed title matcher
  })

  it('a confirmed matcher beats a model label', () => {
    const s = seg()
    recordLabel({ segmentId: s.id, threadId: isp.id, source: 'model', confidence: 0.6 })
    confirmMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: studio.id })

    const r = deriveAttribution(getSegment(s.id)!)
    expect(r.source).toBe('matcher')
    expect(r.threadId).toBe(studio.id)
  })

  it('an UNCONFIRMED matcher does not overturn a model label', () => {
    const s = seg()
    recordLabel({ segmentId: s.id, threadId: isp.id, source: 'model', confidence: 0.7 })
    writeInferredMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: studio.id, confidence: 0.9, example: {} })

    const r = deriveAttribution(getSegment(s.id)!)
    expect(r.source).toBe('model')
    expect(r.threadId).toBe(isp.id) // the guess does not overturn the model
  })

  it('falls through to the model label when no matcher hits', () => {
    const s = seg('sig-no-match', {})
    recordLabel({ segmentId: s.id, threadId: isp.id, source: 'model', confidence: 0.6 })
    expect(deriveAttribution(getSegment(s.id)!).threadId).toBe(isp.id)
  })
})

describe('correction is retroactive (the whole point of Phase 2)', () => {
  it('confirming a rule re-derives a DIFFERENT block that shares the resource', () => {
    // Two segments, same title token, both labelled by the model onto ISP.
    const a = seg('sig-a', { titles: ['studio workbench'] })
    const b = seg('sig-b', { titles: ['studio settings'] })
    for (const s of [a, b]) {
      attributeSegment(s.id, { threadId: isp.id, confidence: 0.5 })
      recordLabel({ segmentId: s.id, threadId: isp.id, source: 'model', confidence: 0.5 })
    }
    // The user confirms "studio -> Studio" and bumps the rules version.
    confirmMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: studio.id })
    bumpRulesVersion()

    const result = rederiveStale({ limit: 50 })
    expect(result.changed).toBe(2)
    expect(getSegment(a.id)!.attributedThreadId).toBe(studio.id)
    expect(getSegment(b.id)!.attributedThreadId).toBe(studio.id)
  })

  it('re-derivation never overturns a user label', () => {
    const s = seg('sig-u', { titles: ['studio'] })
    recordLabel({ segmentId: s.id, threadId: studio.id, source: 'user', confidence: 1 })
    // A confirmed rule pointing the same resource elsewhere...
    confirmMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: isp.id })
    bumpRulesVersion()
    rederiveStale({ limit: 50 })
    expect(getSegment(s.id)!.attributedThreadId).toBe(studio.id) // frozen
  })
})

describe('label-less preservation', () => {
  it('a segment attributed with no label is preserved, never wiped', () => {
    const s = seg('sig-legacy')
    attributeSegment(s.id, { threadId: studio.id, confidence: 0.9 }) // no label written
    bumpRulesVersion()
    const r = deriveAttribution(getSegment(s.id)!)
    expect(r.threadId).toBe(studio.id)
    expect(getSegment(s.id)!.attributedThreadId).toBe(studio.id)
  })
})
