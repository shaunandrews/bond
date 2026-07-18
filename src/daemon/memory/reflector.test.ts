import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { readCoreMemory } from './core-memory'
import { reflectTranscript } from './reflector'

const messages = [{ id: 'u1', role: 'user' as const, text: 'Use Vitest for Bond tests.' }]

describe('memory reflector', () => {
  it('persists validated core memory and sourced memories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bond-reflector-'))
    try {
      const corePath = join(dir, 'core.json')
      const upsert = vi.fn(memory => ({
        id: 'm1',
        kind: memory.kind ?? 'fact',
        text: memory.text,
        source: memory.source ?? 'assistant',
        projectId: memory.projectId ?? null,
        tags: memory.tags ?? [],
        confidence: memory.confidence ?? 1,
        active: true,
        createdAt: 'now',
        updatedAt: 'now',
      }))
      const result = await reflectTranscript({
        messages,
        corePath,
        projectId: 'bond',
        upsert,
        model: { generate: async () => JSON.stringify({
          core: { facts: ['Bond uses Vitest'], preferences: [], decisions: [] },
          memories: [{ kind: 'fact', text: 'Bond uses Vitest for tests.', source: 'assistant', sourceIds: ['u1'] }],
        }) },
      })

      expect(result.errors).toEqual([])
      expect(readCoreMemory(corePath).facts).toEqual(['Bond uses Vitest'])
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ text: 'Bond uses Vitest for tests.', sourceIds: ['u1'] }))
      expect(result.memories[0].id).toBe('m1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports dry run without writes', async () => {
    const upsert = vi.fn()
    const result = await reflectTranscript({
      messages,
      persist: false,
      upsert,
      model: { generate: async () => '{"core":{"facts":["x"]},"memories":[]}' },
    })
    expect(result.coreMemory.facts).toEqual(['x'])
    expect(upsert).not.toHaveBeenCalled()
  })
})
