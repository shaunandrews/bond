import { describe, it, expect } from 'vitest'
import { MODEL_IDS, normalizeModelTier } from './models'

describe('normalizeModelTier', () => {
  it('migrates legacy provider names to tiers', () => {
    expect(normalizeModelTier('opus')).toBe('high')
    expect(normalizeModelTier('sonnet')).toBe('balanced')
    expect(normalizeModelTier('haiku')).toBe('fast')
  })

  it('passes valid tiers through unchanged', () => {
    for (const tier of MODEL_IDS) {
      expect(normalizeModelTier(tier)).toBe(tier)
    }
  })

  it('falls back to balanced for garbage or missing values', () => {
    expect(normalizeModelTier('gpt-4')).toBe('balanced')
    expect(normalizeModelTier('')).toBe('balanced')
    expect(normalizeModelTier(undefined)).toBe('balanced')
  })
})
