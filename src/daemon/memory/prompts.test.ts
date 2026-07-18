import { describe, expect, it } from 'vitest'
import { buildObserverPrompt, renderMemoryContext, renderTranscriptForMemory } from './prompts'

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

  it('builds observer prompt with JSON-only instructions', () => {
    const prompt = buildObserverPrompt({ messages, projectId: 'bond' })
    expect(prompt).toContain('Return one JSON object only')
    expect(prompt).toContain('sourceIds')
    expect(prompt).toContain('"bond"')
  })

  it('renders combined memory context', () => {
    const context = renderMemoryContext({
      core: { version: 1, facts: ['Shaun uses Bond'], preferences: [], decisions: [], updatedAt: 'now' },
      retrieved: [{ id: 'm1', text: 'Use focused tests' }],
    })
    expect(context).toContain('Core memory')
    expect(context).toContain('[m1] Use focused tests')
  })
})
