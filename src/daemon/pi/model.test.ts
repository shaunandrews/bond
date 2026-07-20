import { describe, expect, it } from 'vitest'
import { ANTHROPIC_MODEL_IDS, CODEX_MODEL_IDS, pickModel } from './model'

const anthropic = (id: string) => ({ provider: 'anthropic', id })
const codex = (id: string) => ({ provider: 'openai-codex', id })

describe('pickModel', () => {
  it('prefers the Anthropic model for the tier', () => {
    const available = [codex(CODEX_MODEL_IDS.high), anthropic(ANTHROPIC_MODEL_IDS.high)]
    expect(pickModel(available, 'high')).toEqual(anthropic(ANTHROPIC_MODEL_IDS.high))
  })

  it('falls back to the Codex model for the tier', () => {
    const available = [codex(CODEX_MODEL_IDS.balanced), codex('gpt-other')]
    expect(pickModel(available, 'balanced')).toEqual(codex(CODEX_MODEL_IDS.balanced))
  })

  it('falls back to any Codex model when the tier id is absent', () => {
    expect(pickModel([codex('gpt-other')], 'fast')).toEqual(codex('gpt-other'))
  })

  it('returns undefined when nothing is available', () => {
    expect(pickModel([{ provider: 'someone-else', id: 'x' }], 'high')).toBeUndefined()
  })
})
