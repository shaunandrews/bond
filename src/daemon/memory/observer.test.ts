import { describe, expect, it } from 'vitest'
import { buildSourceIdResolver, observeTranscript, validateSourcedMemories } from './observer'
import { createWorkingState } from './working-state'

const messages = [
  { id: 'u1', role: 'user' as const, text: 'I like terse answers.' },
  { id: 'a1', role: 'bond' as const, text: 'Understood.' },
]

const seqMessages = [
  { id: '3632f4a9-b545-4b01-afcd-f762f65e2848', seq: 696, role: 'user' as const, text: 'ok, on to 7!' },
  { id: '9d1f0b2c-1111-4444-8888-aaaabbbbcccc', seq: 697, role: 'bond' as const, text: 'Filed STU-2085.' },
]

describe('buildSourceIdResolver', () => {
  it('resolves seqs, #seqs, uuids, and uuid case back to the canonical uuid', () => {
    const resolve = buildSourceIdResolver(seqMessages)
    expect(resolve('696')).toBe(seqMessages[0].id)
    expect(resolve('#696')).toBe(seqMessages[0].id)
    expect(resolve('seq=696')).toBe(seqMessages[0].id)
    expect(resolve(' 697 ')).toBe(seqMessages[1].id)
    expect(resolve(seqMessages[0].id)).toBe(seqMessages[0].id)
    expect(resolve(seqMessages[0].id.toUpperCase())).toBe(seqMessages[0].id)
  })

  it('returns null for hallucinated ids', () => {
    // The real rejected token from daemon.log line 9354 — seq 696 dressed up
    // as a uuid, matching no message in the database.
    const resolve = buildSourceIdResolver(seqMessages)
    expect(resolve('696c7b2e-4e1d-45ec-b111-392e90ed7874')).toBeNull()
    expect(resolve('12953a4782b-8fd7-')).toBeNull()
  })
})

describe('memory observer', () => {
  it('validates JSON and keeps memories whose sources resolve', async () => {
    const result = await observeTranscript({
      messages,
      projectId: 'bond',
      sessionId: 's1',
      model: { generate: async () => JSON.stringify({
        workingState: { goal: 'ship memory', facts: ['memory exists'] },
        memories: [
          { kind: 'preference', text: 'Shaun likes terse answers.', source: 'user', tags: ['style'], confidence: 0.9, sourceIds: ['u1'] },
          { kind: 'fact', text: 'invented bad source', sourceIds: ['missing'] },
        ],
      }) },
    })

    expect(result.workingState.goal).toBe('ship memory')
    expect(result.workingState.projectId).toBe('bond')
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].sourceIds).toEqual(['u1'])
    expect(result.errors).toEqual([])
    expect(result.skipped[0]).toMatchObject({ index: 1, reason: expect.stringContaining('unresolvable sourceIds: missing') })
  })

  it('resolves bare sequence numbers to canonical uuids', async () => {
    // 93% of the 160 rejected sourceId tokens in the incident log were bare
    // seqs. They are now the id the prompt asks for.
    const result = await observeTranscript({
      messages: seqMessages,
      model: { generate: async () => JSON.stringify({
        workingState: {},
        memories: [{ kind: 'fact', text: 'Audit item 7 is in flight.', source: 'user', sourceIds: ['696'] }],
      }) },
    })
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].sourceIds).toEqual([seqMessages[0].id])
    expect(result.skipped).toEqual([])
  })

  it('accepts JSON numbers as sourceIds', async () => {
    const result = await observeTranscript({
      messages: seqMessages,
      model: { generate: async () => JSON.stringify({
        memories: [{ kind: 'fact', text: 'Numeric source.', source: 'user', sourceIds: [697] }],
      }) },
    })
    expect(result.memories[0].sourceIds).toEqual([seqMessages[1].id])
  })

  it('keeps a memory that has one good source and one bad one', () => {
    const skipped: Parameters<typeof validateSourcedMemories>[2] = []
    const memories = validateSourcedMemories([
      { text: 'Known', sourceIds: ['696', 'nope'] },
    ], buildSourceIdResolver(seqMessages), skipped)
    expect(memories[0].sourceIds).toEqual([seqMessages[0].id])
    expect(skipped[0].reason).toContain('kept; dropped unresolvable sourceIds: nope')
  })

  it('dedupes sources that resolve to the same message', () => {
    const memories = validateSourcedMemories([
      { text: 'Known', sourceIds: ['696', '#696', seqMessages[0].id] },
    ], buildSourceIdResolver(seqMessages))
    expect(memories[0].sourceIds).toEqual([seqMessages[0].id])
  })

  it('lets the model write checkpoint but never artifacts or activeSkill', async () => {
    // Artifacts are ground truth from Bond's own tool activity. A model guess
    // must not be able to overwrite or invent one.
    const current = createWorkingState({
      artifacts: [{ kind: 'library', ref: '/library/real.md', lastTouchedAt: '2026-07-21T18:00:00.000Z' }],
      activeSkill: 'audit-triage-feedback',
    })
    const result = await observeTranscript({
      messages,
      currentState: current,
      model: { generate: async () => JSON.stringify({
        workingState: {
          checkpoint: 'item 8 of 18 filed; next 9',
          artifacts: [{ kind: 'file', ref: '/invented/path.ts', lastTouchedAt: '2026-07-21T19:00:00.000Z' }],
          activeSkill: 'made-up-skill',
        },
        memories: [],
      }) },
    })

    expect(result.workingState.checkpoint).toBe('item 8 of 18 filed; next 9')
    expect(result.workingState.artifacts.map(a => a.ref)).toEqual(['/library/real.md'])
    expect(result.workingState.activeSkill).toBe('audit-triage-feedback')
  })

  it('returns errors for invalid JSON without throwing', async () => {
    const result = await observeTranscript({ messages, model: { generate: async () => 'nope' } })
    expect(result.memories).toEqual([])
    expect(result.errors[0]).toMatch(/No JSON object/)
  })
})
