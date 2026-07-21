import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { createThread, createSegment, attributeSegment } from './store'
import {
  confirmMatcher,
  deleteMatcher,
  dropInferredMatchersForThread,
  findMatcher,
  getSuppression,
  isSuppressed,
  listMatchers,
  recordMatcherHit,
  recordRejection,
  repointMatcherByUser,
  resolveMatcher,
  setMatcherEnabled,
  writeInferredMatcher,
} from './matchers'
import type { DeskThread } from '../../shared/desk'

let testDir: string
let studio: DeskThread
let isp: DeskThread

beforeEach(() => {
  testDir = join(tmpdir(), `bond-desk-matchers-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  studio = createThread({ name: 'Studio sync dialog', source: 'user' })
  isp = createThread({ name: 'ISP problem', source: 'user' })
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

const RESOURCE = { field: 'resource' as const, operator: 'exact' as const, pattern: 'sig-abc' }

function resolveFor(signature = 'sig-abc', titles: string[] = [], bundleId: string | null = null) {
  return resolveMatcher({ signature, bundleId, titles, paths: [] })
}

describe('authority matrix — inference writes', () => {
  it('inserts an unconfirmed exact-resource matcher when none exists', () => {
    const result = writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.8, example: {} })
    expect(result.action).toBe('inserted')
    expect(result.matcher.confirmed).toBe(false)
    expect(result.matcher.source).toBe('inferred')
  })

  it('refreshes an unconfirmed matcher for the same thread without changing authority', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.5, example: {} })
    const result = writeInferredMatcher({
      ...RESOURCE, threadId: studio.id, confidence: 0.95, example: { titles: ['Sync Dialog'] },
    })
    expect(result.action).toBe('refreshed')
    expect(result.matcher.confidence).toBe(0.95)
    expect(result.matcher.confirmed).toBe(false)
    expect(result.matcher.example.titles).toEqual(['Sync Dialog'])
  })

  it('will not steal a pattern already pointing at another thread', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.8, example: {} })
    const result = writeInferredMatcher({ ...RESOURCE, threadId: isp.id, confidence: 0.99, example: {} })
    expect(result.action).toBe('blocked_other_thread')
    expect(findMatcher(RESOURCE)!.threadId).toBe(studio.id)
  })

  it('cannot mutate or demote a confirmed matcher', () => {
    confirmMatcher({ ...RESOURCE, threadId: studio.id })
    const result = writeInferredMatcher({ ...RESOURCE, threadId: isp.id, confidence: 0.99, example: { titles: ['x'] } })
    expect(result.action).toBe('blocked_confirmed')

    const after = findMatcher(RESOURCE)!
    expect(after.confirmed).toBe(true)
    expect(after.threadId).toBe(studio.id)
    expect(after.confidence).toBe(1)
  })

  it('never sets confirmed = 1, no matter the confidence', () => {
    const result = writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 1, example: {} })
    expect(result.matcher.confirmed).toBe(false)
  })
})

describe('authority matrix — user writes', () => {
  it('a plain reassignment re-points and marks the matcher user-sourced', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.8, example: {} })
    const after = repointMatcherByUser({ ...RESOURCE, threadId: isp.id })
    expect(after.threadId).toBe(isp.id)
    expect(after.source).toBe('user')
    expect(after.confirmed).toBe(false)
  })

  it('a plain reassignment preserves confirmed when it was already confirmed', () => {
    confirmMatcher({ ...RESOURCE, threadId: studio.id })
    const after = repointMatcherByUser({ ...RESOURCE, threadId: isp.id })
    expect(after.confirmed).toBe(true)
    expect(after.threadId).toBe(isp.id)
  })

  it('re-teaching an existing pattern to a different thread succeeds instead of erroring', () => {
    confirmMatcher({ ...RESOURCE, threadId: studio.id, example: { titles: ['old'] } })
    const after = confirmMatcher({ ...RESOURCE, threadId: isp.id, example: { titles: ['new'] } })
    expect(after.threadId).toBe(isp.id)
    expect(after.confirmed).toBe(true)
    expect(after.example.titles).toEqual(['new'])
    expect(listMatchers()).toHaveLength(1)
  })

  it('confirming resets hits and replaces the example', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.4, example: { titles: ['guess'] } })
    recordMatcherHit(findMatcher(RESOURCE)!.id)
    const after = confirmMatcher({ ...RESOURCE, threadId: studio.id, example: { titles: ['approved'] } })
    expect(after.hits).toBe(0)
    expect(after.example.titles).toEqual(['approved'])
    expect(after.confidence).toBe(1)
  })

  it('reassigning a resource nobody has seen before creates the matcher', () => {
    const after = repointMatcherByUser({ ...RESOURCE, threadId: isp.id, example: { appName: 'Studio' } })
    expect(after.threadId).toBe(isp.id)
    expect(after.confirmed).toBe(false)
    expect(after.source).toBe('user')
  })
})

describe('resolution order', () => {
  it('confirmed outranks a more specific unconfirmed matcher', () => {
    writeInferredMatcher({
      field: 'title', operator: 'exact', pattern: 'studio — sync dialog',
      threadId: isp.id, confidence: 1, example: {},
    })
    confirmMatcher({ field: 'bundle', operator: 'exact', pattern: 'com.automattic.studio', threadId: studio.id })

    const hit = resolveMatcher({
      signature: 'sig-abc', bundleId: 'com.automattic.studio', titles: ['Studio — Sync Dialog'], paths: [],
    })
    expect(hit!.threadId).toBe(studio.id)
  })

  it('among equals, the more specific pattern wins', () => {
    writeInferredMatcher({ field: 'title', operator: 'contains', pattern: 'studio', threadId: isp.id, confidence: 1, example: {} })
    writeInferredMatcher({ field: 'title', operator: 'exact', pattern: 'studio — sync dialog', threadId: studio.id, confidence: 1, example: {} })
    expect(resolveFor('sig', ['Studio — Sync Dialog'])!.threadId).toBe(studio.id)
  })

  it('field rank breaks a tie: path > title > bundle > resource', () => {
    // Same operator and same pattern length, so specificity ties.
    writeInferredMatcher({ field: 'bundle', operator: 'exact', pattern: 'aaaaaa', threadId: isp.id, confidence: 1, example: {} })
    writeInferredMatcher({ field: 'title', operator: 'exact', pattern: 'aaaaaa', threadId: studio.id, confidence: 1, example: {} })
    const hit = resolveMatcher({ signature: 'sig', bundleId: 'aaaaaa', titles: ['aaaaaa'], paths: [] })
    expect(hit!.threadId).toBe(studio.id)
  })

  it('honours prefix and contains operators', () => {
    writeInferredMatcher({ field: 'title', operator: 'prefix', pattern: 'studio —', threadId: studio.id, confidence: 1, example: {} })
    expect(resolveFor('sig', ['Studio — Sync Dialog'])!.threadId).toBe(studio.id)
    expect(resolveFor('sig', ['Xcode — Studio —'])).toBeNull()
  })

  it('skips a disabled matcher', () => {
    const m = writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 1, example: {} }).matcher
    setMatcherEnabled(m.id, false)
    expect(resolveFor()).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolveFor('unseen')).toBeNull()
  })
})

describe('suppressions', () => {
  it('one rejection suppresses the pairing for the rest of the day', () => {
    const s = recordRejection('sig-abc', studio.id, { at: '2026-07-20T10:00:00.000Z' })
    expect(s.rejectionCount).toBe(1)
    expect(s.permanent).toBe(false)
    expect(isSuppressed('sig-abc', studio.id, '2026-07-20T15:00:00.000Z')).toBe(true)
  })

  it('three rejections make the suppression permanent', () => {
    recordRejection('sig-abc', studio.id)
    recordRejection('sig-abc', studio.id)
    const s = recordRejection('sig-abc', studio.id)
    expect(s.rejectionCount).toBe(3)
    expect(s.permanent).toBe(true)
    expect(isSuppressed('sig-abc', studio.id, '2099-01-01T00:00:00.000Z')).toBe(true)
  })

  it('an unconfirmed matcher behaves as unmatched while suppressed', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.9, example: {} })
    expect(resolveFor()!.threadId).toBe(studio.id)

    recordRejection('sig-abc', studio.id)
    expect(resolveFor()).toBeNull()
  })

  it('a confirmed matcher outranks a suppression — the user instructed that one', () => {
    confirmMatcher({ ...RESOURCE, threadId: studio.id })
    recordRejection('sig-abc', studio.id)
    expect(resolveFor()!.threadId).toBe(studio.id)
  })

  it('suppression is scoped to one pairing, not the whole resource', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.9, example: {} })
    recordRejection('sig-abc', isp.id)
    expect(resolveFor()!.threadId).toBe(studio.id)
  })

  it('cascades away with its thread', () => {
    recordRejection('sig-abc', studio.id)
    getDb().prepare('DELETE FROM desk_threads WHERE id = ?').run(studio.id)
    expect(getSuppression('sig-abc', studio.id)).toBeNull()
  })

  it('a rejection never creates a positive attribution rule', () => {
    recordRejection('sig-abc', studio.id)
    expect(listMatchers()).toHaveLength(0)
  })
})

describe('rejection rollback', () => {
  it('drops the unconfirmed matcher that produced the suggestion', () => {
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.9, example: {} })
    expect(dropInferredMatchersForThread('sig-abc', studio.id)).toBe(1)
    expect(listMatchers()).toHaveLength(0)
  })

  it('drops a title matcher reached through the segments that used it', () => {
    const m = writeInferredMatcher({
      field: 'title', operator: 'exact', pattern: 'sync dialog', threadId: studio.id, confidence: 0.9, example: {},
    }).matcher
    const seg = createSegment({ blockId: null, startedAt: 'a', resourceSignature: 'sig-abc', evidence: {} })
    attributeSegment(seg.id, { threadId: studio.id, matcherId: m.id, confidence: 0.9 })

    expect(dropInferredMatchersForThread('sig-abc', studio.id)).toBe(1)
    expect(listMatchers()).toHaveLength(0)
  })

  it('never touches a confirmed matcher', () => {
    confirmMatcher({ ...RESOURCE, threadId: studio.id })
    expect(dropInferredMatchersForThread('sig-abc', studio.id)).toBe(0)
    expect(listMatchers()).toHaveLength(1)
  })

  it('leaves another thread’s matcher for the same resource alone', () => {
    writeInferredMatcher({
      field: 'title', operator: 'exact', pattern: 'other', threadId: isp.id, confidence: 0.9, example: {},
    })
    writeInferredMatcher({ ...RESOURCE, threadId: studio.id, confidence: 0.9, example: {} })
    dropInferredMatchersForThread('sig-abc', studio.id)
    expect(listMatchers().map(m => m.threadId)).toEqual([isp.id])
  })
})

describe('the rules editor surface', () => {
  it('lists confirmed matchers with their examples', () => {
    confirmMatcher({ ...RESOURCE, threadId: studio.id, example: { titles: ['Studio — Sync Dialog'] } })
    writeInferredMatcher({ field: 'title', operator: 'exact', pattern: 'noise', threadId: isp.id, confidence: 0.2, example: {} })
    const confirmed = listMatchers({ confirmedOnly: true })
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].example.titles).toEqual(['Studio — Sync Dialog'])
  })

  it('deletes a bad matcher', () => {
    const m = confirmMatcher({ ...RESOURCE, threadId: studio.id })
    expect(deleteMatcher(m.id)).toBe(true)
    expect(deleteMatcher(m.id)).toBe(false)
    expect(listMatchers()).toHaveLength(0)
  })
})
