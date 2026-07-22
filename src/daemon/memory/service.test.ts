import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../db'
import { createEpoch, findEpoch } from '../epochs'
import { getLibraryDir } from '../library'
import { getSkillsDir, setDataDir } from '../paths'
import { insertTurnStart, upsertMessages } from '../transcript'
import { readCoreMemory, writeCoreMemoryAtomic } from './core-memory'
import { listMemoryRuns } from './ledger'
import { getMemoryItemSourceIds, searchMemory } from './store'
import { enqueueMemoryTask, finalObserverHook, observeAndPersistRange, observeEpochThrough, readWorkingMemoryState, recordToolEventArtifacts, reflectAndPersistRange, reflectEpochThrough, shouldObserveAfterTurn, shouldReflectAfterTurn, waitForMemoryQueue } from './service'

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

/**
 * Fixtures below are copied from real daemon.log failures on 2026-07-21 — the
 * run that froze working memory for five hours while the marker never moved.
 */
describe('memory observer survivability', () => {
  function seedTurn(): void {
    createEpoch({ id: 'epoch-1', piSessionId: 'pi-1' })
    insertTurnStart({
      epochId: 'epoch-1',
      turnId: 'turn-1',
      userMessageId: 'u1',
      assistantMessageId: 'b1',
      activityMessageId: 'a1',
      text: 'ok, on to 7!',
    })
    upsertMessages([{ id: 'b1', epochId: 'epoch-1', turnId: 'turn-1', role: 'bond', text: 'Filed STU-2085.' }])
  }

  it('resolves a bare seq sourceId to the canonical message uuid', async () => {
    seedTurn()
    const userSeq = (getDb().prepare("SELECT seq FROM messages WHERE id = 'u1'").get() as { seq: number }).seq

    await observeAndPersistRange({
      fromSeq: 1,
      toSeq: 5,
      model: { generate: async () => JSON.stringify({
        workingState: { goal: 'Continue the Studio trunk audit' },
        memories: [{ id: 'm1', kind: 'fact', text: 'Audit item 7 is in flight.', source: 'user', sourceIds: [String(userSeq)] }],
      }) },
    })

    expect(getMemoryItemSourceIds('m1')).toEqual(['u1'])
  })

  it('persists the valid half of a mixed batch and still writes working state', async () => {
    seedTurn()
    const result = await observeAndPersistRange({
      fromSeq: 1,
      toSeq: 5,
      model: { generate: async () => JSON.stringify({
        workingState: { goal: 'Continue the Studio trunk audit' },
        memories: [
          { id: 'm1', kind: 'fact', text: 'Audit item 7 is in flight.', source: 'user', sourceIds: ['u1'] },
          // The literal hallucinated uuid rejected at daemon.log line 9354.
          { id: 'm2', kind: 'fact', text: 'Invented.', source: 'user', sourceIds: ['696c7b2e-4e1d-45ec-b111-392e90ed7874'] },
        ],
      }) },
    })

    expect(result.outcome).toBe('partial')
    expect(result.persistedCount).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(readWorkingMemoryState().goal).toBe('Continue the Studio trunk audit')
    expect(searchMemory('Invented')).toEqual([])
  })

  it('writes working state and advances the marker when every memory is invalid', async () => {
    // Replica of log line 7203: ten memories, every sourceId a bare seq that is
    // not in range. Under the old all-or-nothing throw this froze the pipeline.
    seedTurn()
    const memories = Array.from({ length: 10 }, (_, i) => ({
      kind: 'fact', text: `Bogus ${i}`, source: 'user', sourceIds: [String(9000 + i)],
    }))

    await observeEpochThrough({
      epochId: 'epoch-1',
      toSeq: 5,
      model: { generate: async () => JSON.stringify({ workingState: { goal: 'Studio trunk audit' }, memories }) },
    })

    expect(readWorkingMemoryState().goal).toBe('Studio trunk audit')
    expect(findEpoch('epoch-1')?.observedThroughSeq).toBe(5)
    expect(listMemoryRuns()[0]).toMatchObject({ kind: 'observer', outcome: 'partial', persistedCount: 0, skippedCount: 10 })
  })

  it('retries a parse failure once, then advances anyway', async () => {
    seedTurn()
    const generate = vi.fn(async () => 'not json at all')

    await observeEpochThrough({ epochId: 'epoch-1', toSeq: 5, model: { generate } })

    expect(generate).toHaveBeenCalledTimes(2)
    expect(findEpoch('epoch-1')?.observedThroughSeq).toBe(5)
    expect(listMemoryRuns()[0]).toMatchObject({ outcome: 'parse_failed' })
  })

  it('does NOT advance the marker when the model call itself throws', async () => {
    seedTurn()
    const before = findEpoch('epoch-1')!.observedThroughSeq

    await expect(observeEpochThrough({
      epochId: 'epoch-1',
      toSeq: 5,
      model: { generate: async () => { throw new Error('socket hang up') } },
    })).rejects.toThrow('socket hang up')

    expect(findEpoch('epoch-1')?.observedThroughSeq).toBe(before)
    expect(listMemoryRuns()[0]).toMatchObject({ outcome: 'transport_failed', reason: 'socket hang up' })
  })

  it('never moves the marker backwards, whatever the model returns', async () => {
    seedTurn()
    const responses = [
      '{"memories":[{"text":"ok","sourceIds":["u1"]}]}',
      'garbage',
      '{"workingState":{"goal":""},"memories":[{"text":"bad","sourceIds":["4242"]}]}',
      '{}',
      '[]',
    ]
    for (const response of responses) {
      const before = findEpoch('epoch-1')!.observedThroughSeq
      await observeEpochThrough({ epochId: 'epoch-1', toSeq: 5, model: { generate: async () => response } })
      const after = findEpoch('epoch-1')!.observedThroughSeq
      expect(after).toBeGreaterThanOrEqual(before)
    }
    expect(findEpoch('epoch-1')?.observedThroughSeq).toBe(5)
  })
})

describe('reflection has its own cadence', () => {
  it('fires only once the interval is crossed, and advances its own marker', async () => {
    // Rollover is a backstop now (soft limit 0.92), so an epoch can live for
    // days. Reflection tied to rollover would simply stop happening.
    expect(shouldReflectAfterTurn({ reflectedThroughSeq: 0, toSeq: 199 })).toBe(false)
    expect(shouldReflectAfterTurn({ reflectedThroughSeq: 0, toSeq: 200 })).toBe(true)
    expect(shouldReflectAfterTurn({ reflectedThroughSeq: 700, toSeq: 899 })).toBe(false)

    createEpoch({ id: 'epoch-r', piSessionId: 'pi-r' })
    insertTurnStart({ epochId: 'epoch-r', turnId: 't1', userMessageId: 'u1', assistantMessageId: 'b1', activityMessageId: 'a1', text: 'I prefer terse answers.' })

    await reflectEpochThrough({
      epochId: 'epoch-r',
      toSeq: 3,
      model: { generate: async () => JSON.stringify({ core: { facts: ['Prefers terse answers'], preferences: [], decisions: [] }, memories: [] }) },
    })

    expect(findEpoch('epoch-r')?.reflectedThroughSeq).toBe(3)
    expect(readCoreMemory().facts).toContain('Prefers terse answers')
  })
})

describe('legacy epochs with unseeded markers', () => {
  it('reflects only its own messages, not the entire transcript', async () => {
    // The live active epoch on 2026-07-21 had reflected_through_seq = 0 with
    // 876 messages behind it. Without the clamp, the first scheduled reflection
    // would have sent the whole transcript (~150k chars) to the fast model.
    createEpoch({ id: 'epoch-old', piSessionId: 'pi-old' })
    insertTurnStart({ epochId: 'epoch-old', turnId: 't-old', userMessageId: 'uo', assistantMessageId: 'bo', activityMessageId: 'ao', text: 'ancient history' })
    getDb().prepare("UPDATE epochs SET status = 'closed' WHERE id = ?").run('epoch-old')

    createEpoch({ id: 'epoch-new', piSessionId: 'pi-new' })
    insertTurnStart({ epochId: 'epoch-new', turnId: 't-new', userMessageId: 'un', assistantMessageId: 'bn', activityMessageId: 'an', text: 'current work' })
    // Simulate the pre-seeding row shape.
    getDb().prepare('UPDATE epochs SET reflected_through_seq = 0, observed_through_seq = 0 WHERE id = ?').run('epoch-new')

    let seenPrompt = ''
    await reflectEpochThrough({
      epochId: 'epoch-new',
      toSeq: 6,
      model: { generate: async (prompt: string) => { seenPrompt = prompt; return '{"core":{"facts":[],"preferences":[],"decisions":[]},"memories":[]}' } },
    })

    expect(seenPrompt).toContain('current work')
    expect(seenPrompt).not.toContain('ancient history')
    expect(findEpoch('epoch-new')?.reflectedThroughSeq).toBe(6)
  })
})

describe('deterministic artifact capture', () => {
  it('a written library document reaches working memory with no model call', async () => {
    recordToolEventArtifacts({
      toolName: 'write',
      args: { path: `${getLibraryDir()}/058eb00f-4d8c-4bb2-93c4-a4aaa16e7290.md`, content: '# Studio trunk audit' },
    })
    await waitForMemoryQueue()

    const working = readWorkingMemoryState()
    expect(working.artifacts).toHaveLength(1)
    expect(working.artifacts[0]).toMatchObject({ kind: 'library', ref: expect.stringContaining('058eb00f') })
  })

  it('a SKILL.md read sets the active skill', async () => {
    recordToolEventArtifacts({ toolName: 'read', args: { path: join(getSkillsDir(), 'audit-triage-feedback', 'SKILL.md') } })
    await waitForMemoryQueue()
    expect(readWorkingMemoryState().activeSkill).toBe('audit-triage-feedback')
  })

  it('drops an artifact whose ref trips redaction', async () => {
    recordToolEventArtifacts({ toolName: 'write', args: { path: `/tmp/sk-${'a'.repeat(48)}/notes.md` } })
    await waitForMemoryQueue()
    expect(readWorkingMemoryState().artifacts).toEqual([])
  })

  it('ignores tools that name nothing worth remembering', async () => {
    recordToolEventArtifacts({ toolName: 'bash', args: { command: 'ls -la' } })
    await waitForMemoryQueue()
    expect(readWorkingMemoryState().artifacts).toEqual([])
  })
})

describe('core memory is additive', () => {
  function seedTurn(): void {
    createEpoch({ id: 'epoch-c', piSessionId: 'pi-c' })
    insertTurnStart({
      epochId: 'epoch-c',
      turnId: 'turn-c',
      userMessageId: 'u1',
      assistantMessageId: 'b1',
      activityMessageId: 'a1',
      text: 'I always want tests alongside the code.',
    })
  }

  it('adds new items without dropping the ones the model did not repeat', async () => {
    seedTurn()
    const existing = Array.from({ length: 9 }, (_, i) => `Existing fact ${i}`)
    writeCoreMemoryAtomic({ version: 1, facts: existing, preferences: [], decisions: [], updatedAt: '2026-07-21T15:42:04.000Z' })

    await reflectAndPersistRange({
      fromSeq: 1,
      toSeq: 5,
      model: { generate: async () => JSON.stringify({
        core: { facts: ['Shaun wants tests alongside code', 'Shaun designs first'], preferences: [], decisions: [] },
        memories: [],
      }) },
    })

    const core = readCoreMemory()
    expect(core.facts).toHaveLength(11)
    expect(core.facts).toEqual(expect.arrayContaining([...existing, 'Shaun wants tests alongside code']))
  })

  it('leaves core untouched when the model returns nothing', async () => {
    seedTurn()
    writeCoreMemoryAtomic({ version: 1, facts: ['Keep me'], preferences: [], decisions: [], updatedAt: '2026-07-21T15:42:04.000Z' })

    await reflectAndPersistRange({ fromSeq: 1, toSeq: 5, model: { generate: async () => '{"core":{"facts":[],"preferences":[],"decisions":[]},"memories":[]}' } })

    expect(readCoreMemory().facts).toEqual(['Keep me'])
  })

  it('keeps core intact through a parse failure', async () => {
    seedTurn()
    writeCoreMemoryAtomic({ version: 1, facts: ['Keep me'], preferences: [], decisions: [], updatedAt: '2026-07-21T15:42:04.000Z' })

    const result = await reflectAndPersistRange({ fromSeq: 1, toSeq: 5, model: { generate: async () => 'nope' } })

    expect(result.outcome).toBe('parse_failed')
    expect(readCoreMemory().facts).toEqual(['Keep me'])
  })
})

describe('deferred memory queue', () => {
  it('finalObserverHook completes when executed on the memory queue', async () => {
    // Regression: the hook used to await waitForMemoryQueue() internally.
    // Now that rollover hook work is enqueued ONTO that queue, the old wait
    // would be a self-deadlock — the queue only resolves when the hook does.
    createEpoch({ id: 'epoch-dl', piSessionId: 'pi-dl' })

    let ran = false
    enqueueMemoryTask(async () => {
      // toSeq 0 means nothing to observe — the hook returns immediately if
      // (and only if) it is not waiting on its own queue slot.
      await finalObserverHook({ epoch: (await import('../epochs')).findEpoch('epoch-dl')!, fromSeq: 1, toSeq: 0, messages: [] })
      ran = true
    })

    await Promise.race([
      waitForMemoryQueue(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('memory queue deadlocked')), 2000)),
    ])
    expect(ran).toBe(true)
  })
})
