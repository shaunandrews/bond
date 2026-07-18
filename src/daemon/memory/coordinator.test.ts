import { describe, expect, it, vi } from 'vitest'
import { createMemoryCoordinator } from './coordinator'

vi.mock('../transcript', () => ({
  getMessagesForRange: vi.fn(() => [{ id: 'u1', role: 'user', text: 'Remember this.' }]),
}))

describe('memory coordinator', () => {
  it('observes transcript ranges with injectable model', async () => {
    const coordinator = createMemoryCoordinator({
      model: { generate: async () => JSON.stringify({ workingState: { goal: 'remember' }, memories: [{ text: 'Remember this.', sourceIds: ['u1'] }] }) },
    })
    const result = await coordinator.observeRange({ fromSeq: 1, toSeq: 1, sessionId: 's1' })
    expect(result.workingState.goal).toBe('remember')
    expect(result.memories[0].text).toBe('Remember this.')
  })

  it('normalizes invalid ranges', async () => {
    const warn = vi.fn()
    const coordinator = createMemoryCoordinator({ model: { generate: async () => '{}' }, logger: { warn } })
    await coordinator.observeRange({ fromSeq: 2.8, toSeq: 1.2 })
    expect(warn).toHaveBeenCalled()
  })
})
