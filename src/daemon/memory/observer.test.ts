import { describe, expect, it } from 'vitest'
import { observeTranscript, validateSourcedMemories } from './observer'

const messages = [
  { id: 'u1', role: 'user' as const, text: 'I like terse answers.' },
  { id: 'a1', role: 'bond' as const, text: 'Understood.' },
]

describe('memory observer', () => {
  it('validates JSON and source ids from model output', async () => {
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
    expect(result.errors).toContain('memories[1] has no valid sourceIds')
  })

  it('returns errors for invalid JSON without throwing', async () => {
    const result = await observeTranscript({ messages, model: { generate: async () => 'nope' } })
    expect(result.memories).toEqual([])
    expect(result.errors[0]).toMatch(/No JSON object/)
  })

  it('dedupes and reports unknown source ids', () => {
    const errors: string[] = []
    const memories = validateSourcedMemories([
      { text: 'Known', sourceIds: ['u1', 'u1', 'nope'] },
    ], new Set(['u1']), errors)
    expect(memories[0].sourceIds).toEqual(['u1'])
    expect(errors).toEqual(['memories[0] has unknown sourceIds: nope'])
  })
})
