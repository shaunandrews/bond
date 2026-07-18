import { describe, expect, it } from 'vitest'
import { MEMORY_CAPS } from './types'
import { parseJsonObject, validateCoreMemory, validateMemoryItemInput, validateWorkingState } from './parser'

describe('memory parser', () => {
  it('extracts a JSON object from model prose', () => {
    const result = parseJsonObject('Here you go:\n```json\n{"facts":["one"]}\n```')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ facts: ['one'] })
  })

  it('validates memory item schema and clamps deterministic caps', () => {
    const result = validateMemoryItemInput({
      text: '  hello   world  ',
      kind: 'fact',
      source: 'user',
      tags: ['Bond', 'bond', 'x'.repeat(100)],
      confidence: 3,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toBe('hello world')
    expect(result.value.tags).toEqual(['Bond', 'x'.repeat(MEMORY_CAPS.tagChars)])
    expect(result.value.confidence).toBe(1)
  })

  it('rejects invalid enum values', () => {
    const result = validateMemoryItemInput({ text: 'valid text', kind: 'mood-ring', source: 'goblin' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toEqual(['kind is invalid', 'source is invalid'])
  })

  it('caps working state lists predictably', () => {
    const result = validateWorkingState({
      facts: Array.from({ length: MEMORY_CAPS.workingFacts + 5 }, (_, i) => `fact ${i}`),
      preferences: ['A', 'a', 'B'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.facts).toHaveLength(MEMORY_CAPS.workingFacts)
    expect(result.value.facts[0]).toBe('fact 0')
    expect(result.value.preferences).toEqual(['A', 'B'])
  })

  it('validates core memory with caps', () => {
    const result = validateCoreMemory({
      version: 999,
      facts: Array.from({ length: MEMORY_CAPS.coreFacts + 1 }, (_, i) => `fact ${i}`),
      preferences: ['pref'],
      decisions: ['decision'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(1)
    expect(result.value.facts).toHaveLength(MEMORY_CAPS.coreFacts)
  })
})
