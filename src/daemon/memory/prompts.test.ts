import { describe, expect, it } from 'vitest'
import { buildObserverPrompt, renderMemoryContext, renderStableMemoryState, renderTranscriptForMemory } from './prompts'
import { createWorkingState } from './working-state'

const messages = [
  { id: 'u1', role: 'user' as const, text: 'I prefer restrained UI.' },
  { id: 'a1', role: 'bond' as const, text: 'Noted.' },
]

describe('memory prompts', () => {
  it('renders transcript with stable source ids', () => {
    const rendered = renderTranscriptForMemory(messages)
    expect(rendered).toContain('<message id="u1" role="user"')
    expect(rendered).toContain('I prefer restrained UI.')
  })

  it('emits exactly one identifier per message, preferring seq', () => {
    // Regression: emitting both id="<uuid>" and seq=<n> and then asking for
    // "the message ids" produced 149 rejected bare-seq sourceIds in one day.
    const rendered = renderTranscriptForMemory([
      { id: '3632f4a9-b545-4b01-afcd-f762f65e2848', seq: 696, role: 'user' as const, text: 'ok, on to 7!' },
    ])
    expect(rendered).toContain('<message id="696" role="user"')
    expect(rendered).not.toContain('seq=')
    expect(rendered).not.toContain('3632f4a9')
  })

  it('builds observer prompt with JSON-only instructions', () => {
    const prompt = buildObserverPrompt({ messages, projectId: 'bond' })
    expect(prompt).toContain('Return one JSON object only')
    expect(prompt).toContain('sourceIds')
    expect(prompt).toContain('"bond"')
  })

  it('renders only query-specific retrieval into the envelope context', () => {
    const context = renderMemoryContext({ retrieved: [{ id: 'm1', text: 'Use focused tests' }] })
    expect(context).toContain('[m1] Use focused tests')
    expect(context).not.toContain('Core memory')
    expect(renderMemoryContext({ retrieved: [] })).toBe('')
  })

  it('renders core and working state as the stable half', () => {
    const state = renderStableMemoryState(
      { version: 1, facts: ['Shaun uses Bond'], preferences: [], decisions: [], updatedAt: 'now' },
      createWorkingState({ goal: 'Ship memory reliability', artifacts: [{ kind: 'library', ref: '/library/058eb00f.md', lastTouchedAt: 'now' }] }),
    )
    expect(state).toContain('Core memory')
    expect(state).toContain('Shaun uses Bond')
    expect(state).toContain('Working memory')
    expect(state).toContain('058eb00f')
  })
})
