import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../db'
import { createEpoch } from '../epochs'
import { setDataDir } from '../paths'
import { insertTurnStart, upsertMessages } from '../transcript'
import { getMemoryItemSourceIds, searchMemory } from './store'
import { observeAndPersistRange, readWorkingMemoryState, shouldObserveAfterTurn } from './service'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-memory-service-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

describe('memory service', () => {
  it('observes explicit memory cues without waiting for the periodic threshold', () => {
    expect(shouldObserveAfterTurn({ userText: 'Remember that I prefer terse answers.', observedThroughSeq: 10, toSeq: 13 })).toBe(true)
    expect(shouldObserveAfterTurn({ userText: 'Thanks.', observedThroughSeq: 10, toSeq: 13 })).toBe(false)
    expect(shouldObserveAfterTurn({ userText: 'Continue.', observedThroughSeq: 1, toSeq: 25 })).toBe(true)
  })

  it('persists working state, durable memory, and relational sources', async () => {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({
      epochId: 'epoch-1',
      turnId: 'turn-1',
      userMessageId: 'u1',
      assistantMessageId: 'b1',
      activityMessageId: 'a1',
      text: 'Remember that I prefer terse answers.',
    })
    upsertMessages([{ id: 'b1', epochId: 'epoch-1', turnId: 'turn-1', role: 'bond', text: 'I will remember that.' }])

    await observeAndPersistRange({
      fromSeq: 1,
      toSeq: 3,
      sessionId: 'pi-1',
      model: {
        generate: async () => JSON.stringify({
          workingState: { preferences: ['Prefers terse answers'] },
          memories: [{ id: 'm1', kind: 'preference', text: 'Prefers terse answers', source: 'user', sourceIds: ['u1'] }],
        }),
      },
    })

    expect(readWorkingMemoryState().preferences).toContain('Prefers terse answers')
    expect(searchMemory('terse answers')[0]?.item.id).toBe('m1')
    expect(getMemoryItemSourceIds('m1')).toEqual(['u1'])
  })
})
