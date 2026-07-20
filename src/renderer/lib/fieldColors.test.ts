import { describe, it, expect } from 'vitest'
import { fieldColorVar, optionColorVar } from './fieldColors'
import type { FieldDef } from '../../shared/session'

describe('fieldColorVar', () => {
  it('maps palette keys to CSS custom properties', () => {
    expect(fieldColorVar('red')).toBe('var(--field-red)')
    expect(fieldColorVar('gray')).toBe('var(--field-gray)')
  })

  it('rejects unknown or missing keys', () => {
    expect(fieldColorVar('hotpink')).toBeNull()
    expect(fieldColorVar(undefined)).toBeNull()
    expect(fieldColorVar('')).toBeNull()
  })
})

describe('optionColorVar', () => {
  const def: FieldDef = {
    name: 'status',
    type: 'status',
    options: [
      { value: 'open', color: 'gray' },
      { value: 'done', color: 'green' },
      { value: 'odd' },
    ],
  }

  it('resolves the color of the matching option', () => {
    expect(optionColorVar(def, 'done')).toBe('var(--field-green)')
  })

  it('returns null for colorless options and unknown values', () => {
    expect(optionColorVar(def, 'odd')).toBeNull()
    expect(optionColorVar(def, 'nope')).toBeNull()
    expect(optionColorVar({ name: 't', type: 'text' }, 'x')).toBeNull()
  })
})
