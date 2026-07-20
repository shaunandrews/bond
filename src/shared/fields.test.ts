import { describe, it, expect } from 'vitest'
import {
  FIELD_TYPES,
  FIELD_TYPE_NAMES,
  DEFAULT_PRIORITY_OPTIONS,
  ISSUE_KEY_RE,
  ISSUE_PREFIX_RE,
  parseIssueKey,
  isOptionedType,
  isDoneValue,
  optionsOf,
  optionLabel,
  formatFieldValue,
  compareFieldValues,
  normalizeSchema,
  validateSchema,
  coerceItemData,
} from './fields'
import type { FieldDef } from './session'

const textDef: FieldDef = { name: 'title', type: 'text', primary: true }
const numberDef: FieldDef = { name: 'price', type: 'number', prefix: '$', suffix: '/mo' }
const dateDef: FieldDef = { name: 'due', type: 'date' }
const boolDef: FieldDef = { name: 'done', type: 'boolean' }
const ratingDef: FieldDef = { name: 'stars', type: 'rating', max: 5 }
const urlDef: FieldDef = { name: 'link', type: 'url' }
const tagsDef: FieldDef = { name: 'tags', type: 'tags' }
const selectDef: FieldDef = {
  name: 'area',
  type: 'select',
  options: [{ value: 'Sense' }, { value: 'Chat' }],
}
const multiDef: FieldDef = {
  name: 'genres',
  type: 'multiselect',
  options: [{ value: 'drama' }, { value: 'comedy' }, { value: 'sci-fi' }],
}
const statusDef: FieldDef = {
  name: 'status',
  type: 'status',
  options: [
    { value: 'open', category: 'open', color: 'gray' },
    { value: 'in progress', category: 'active', color: 'blue' },
    { value: 'done', category: 'done', color: 'green' },
    { value: 'wontfix', category: 'cancelled', color: 'red' },
  ],
}
const priorityDef: FieldDef = {
  name: 'priority',
  type: 'priority',
  options: DEFAULT_PRIORITY_OPTIONS.map(o => ({ ...o })),
}

describe('registry completeness', () => {
  it('has an entry for every field type', () => {
    expect(FIELD_TYPE_NAMES).toContain('status')
    expect(FIELD_TYPE_NAMES).toContain('priority')
    for (const name of FIELD_TYPE_NAMES) {
      expect(FIELD_TYPES[name]).toBeDefined()
    }
  })
})

describe('text', () => {
  it('coerces numbers/booleans to strings', () => {
    expect(FIELD_TYPES.text.coerce(42, textDef)).toEqual({ ok: true, value: '42' })
    expect(FIELD_TYPES.text.coerce(true, textDef)).toEqual({ ok: true, value: 'true' })
  })
  it('treats empty string as not set', () => {
    expect(FIELD_TYPES.text.coerce('', textDef)).toEqual({ ok: true, value: undefined })
  })
  it('rejects objects', () => {
    expect(FIELD_TYPES.text.coerce({}, textDef).ok).toBe(false)
  })
})

describe('number', () => {
  it('coerces numeric strings', () => {
    expect(FIELD_TYPES.number.coerce('12.5', numberDef)).toEqual({ ok: true, value: 12.5 })
  })
  it('rejects non-numeric strings (no NaN storage)', () => {
    const r = FIELD_TYPES.number.coerce('cheap', numberDef)
    expect(r.ok).toBe(false)
  })
  it('formats with prefix/suffix', () => {
    expect(FIELD_TYPES.number.format(9, numberDef)).toBe('$9/mo')
  })
  it('compares numerically', () => {
    expect(FIELD_TYPES.number.compare(2, 10, numberDef)).toBeLessThan(0)
  })
})

describe('date', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(FIELD_TYPES.date.coerce('2026-07-19', dateDef)).toEqual({ ok: true, value: '2026-07-19' })
  })
  it('truncates ISO timestamps to the date part', () => {
    expect(FIELD_TYPES.date.coerce('2026-07-19T10:00:00Z', dateDef)).toEqual({ ok: true, value: '2026-07-19' })
  })
  it('rejects impossible calendar dates', () => {
    expect(FIELD_TYPES.date.coerce('2026-02-30', dateDef).ok).toBe(false)
  })
  it('rejects free-form text', () => {
    expect(FIELD_TYPES.date.coerce('next tuesday', dateDef).ok).toBe(false)
  })
})

describe('boolean', () => {
  it.each([['yes', true], ['No', false], ['1', true], ['off', false], ['TRUE', true]])(
    'coerces %s → %s', (raw, expected) => {
      expect(FIELD_TYPES.boolean.coerce(raw, boolDef)).toEqual({ ok: true, value: expected })
    })
  it('rejects ambiguous words', () => {
    expect(FIELD_TYPES.boolean.coerce('maybe', boolDef).ok).toBe(false)
  })
  it('formats Yes/No', () => {
    expect(FIELD_TYPES.boolean.format(true, boolDef)).toBe('Yes')
    expect(FIELD_TYPES.boolean.format(false, boolDef)).toBe('No')
  })
})

describe('select', () => {
  it('resolves case-insensitively to the canonical option value', () => {
    expect(FIELD_TYPES.select.coerce('sense', selectDef)).toEqual({ ok: true, value: 'Sense' })
  })
  it('rejects non-members with the allowed list in the message', () => {
    const r = FIELD_TYPES.select.coerce('Bogus', selectDef)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Sense, Chat')
  })
  it('validates membership strictly', () => {
    expect(FIELD_TYPES.select.validate('Sense', selectDef)).toBeNull()
    expect(FIELD_TYPES.select.validate('nope', selectDef)).toContain('not an option')
  })
  it('compares by option order, not alphabetically', () => {
    expect(FIELD_TYPES.select.compare('Sense', 'Chat', selectDef)).toBeLessThan(0)
  })
  it('formats via label when present', () => {
    const def: FieldDef = { name: 'x', type: 'select', options: [{ value: 'wip', label: 'In Progress' }] }
    expect(FIELD_TYPES.select.format('wip', def)).toBe('In Progress')
  })
})

describe('multiselect', () => {
  it('coerces comma strings and validates each member', () => {
    expect(FIELD_TYPES.multiselect.coerce('drama, comedy', multiDef)).toEqual({ ok: true, value: ['drama', 'comedy'] })
    expect(FIELD_TYPES.multiselect.coerce('drama, western', multiDef).ok).toBe(false)
  })
  it('accepts arrays', () => {
    expect(FIELD_TYPES.multiselect.coerce(['sci-fi'], multiDef)).toEqual({ ok: true, value: ['sci-fi'] })
  })
})

describe('rating', () => {
  it('enforces 0..max integers', () => {
    expect(FIELD_TYPES.rating.coerce(3, ratingDef)).toEqual({ ok: true, value: 3 })
    expect(FIELD_TYPES.rating.coerce(6, ratingDef).ok).toBe(false)
    expect(FIELD_TYPES.rating.coerce(2.5, ratingDef).ok).toBe(false)
    expect(FIELD_TYPES.rating.coerce(-1, ratingDef).ok).toBe(false)
  })
  it('formats as stars', () => {
    expect(FIELD_TYPES.rating.format(3, ratingDef)).toBe('★★★☆☆')
  })
})

describe('url', () => {
  it('accepts http(s) URLs only', () => {
    expect(FIELD_TYPES.url.coerce('https://a8c.com', urlDef)).toEqual({ ok: true, value: 'https://a8c.com' })
    expect(FIELD_TYPES.url.coerce('ftp://x', urlDef).ok).toBe(false)
    expect(FIELD_TYPES.url.coerce('not a url', urlDef).ok).toBe(false)
  })
})

describe('tags', () => {
  it('splits, trims, and drops empties', () => {
    expect(FIELD_TYPES.tags.coerce('a, , b ,c', tagsDef)).toEqual({ ok: true, value: ['a', 'b', 'c'] })
  })
  it('empty list means not set', () => {
    expect(FIELD_TYPES.tags.coerce(' , ', tagsDef)).toEqual({ ok: true, value: undefined })
  })
})

describe('status', () => {
  it('is an optioned type with membership checks', () => {
    expect(isOptionedType('status')).toBe(true)
    expect(FIELD_TYPES.status.coerce('done', statusDef)).toEqual({ ok: true, value: 'done' })
    expect(FIELD_TYPES.status.coerce('finished', statusDef).ok).toBe(false)
  })
  it('defaults new items to the first option', () => {
    expect(FIELD_TYPES.status.defaultValue(statusDef)).toBe('open')
  })
  it('isDoneValue treats done and cancelled categories as done', () => {
    expect(isDoneValue(statusDef, 'done')).toBe(true)
    expect(isDoneValue(statusDef, 'wontfix')).toBe(true)
    expect(isDoneValue(statusDef, 'open')).toBe(false)
    expect(isDoneValue(selectDef, 'Sense')).toBe(false) // non-status fields never
  })
  it('compares by workflow order', () => {
    expect(FIELD_TYPES.status.compare('open', 'done', statusDef)).toBeLessThan(0)
  })
})

describe('priority', () => {
  it('ranks by option order (urgent first)', () => {
    expect(FIELD_TYPES.priority.compare('urgent', 'low', priorityDef)).toBeLessThan(0)
  })
  it('validates membership', () => {
    expect(FIELD_TYPES.priority.validate('high', priorityDef)).toBeNull()
    expect(FIELD_TYPES.priority.validate('critical', priorityDef)).toContain('not an option')
  })
})

describe('formatFieldValue / compareFieldValues wrappers', () => {
  it('is total over garbage', () => {
    expect(formatFieldValue({ weird: true }, textDef)).toBe('{"weird":true}')
    expect(formatFieldValue(undefined, numberDef)).toBe('')
    expect(formatFieldValue(['a', 'b'], textDef)).toBe('a, b')
  })
  it('sorts null/undefined last', () => {
    expect(compareFieldValues(null, 'a', textDef)).toBeGreaterThan(0)
    expect(compareFieldValues('a', undefined, textDef)).toBeLessThan(0)
    expect(compareFieldValues(null, null, textDef)).toBe(0)
  })
})

describe('normalizeSchema', () => {
  it('upgrades legacy string[] options to FieldOption[]', () => {
    const [def] = normalizeSchema([{ name: 's', type: 'select', options: ['a', 'b'] }])
    expect(def.options).toEqual([{ value: 'a' }, { value: 'b' }])
  })
  it('fills status categories and colors', () => {
    const [def] = normalizeSchema([{ name: 'status', type: 'status', options: ['todo', { value: 'done', category: 'done' }] }])
    expect(def.options?.[0]).toEqual({ value: 'todo', category: 'open', color: 'gray' })
    expect(def.options?.[1]).toEqual({ value: 'done', category: 'done', color: 'green' })
  })
  it('gives priority fields the default set when options are missing', () => {
    const [def] = normalizeSchema([{ name: 'priority', type: 'priority' }])
    expect(def.options?.map(o => o.value)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
  })
  it('drops invalid colors and preserves canonical input untouched', () => {
    const canonical = [{ name: 's', type: 'select' as const, options: [{ value: 'a', color: 'blue' as const }] }]
    expect(normalizeSchema(canonical)[0].options).toEqual([{ value: 'a', color: 'blue' }])
    const bad = normalizeSchema([{ name: 's', type: 'select', options: [{ value: 'a', color: 'hotpink' as never }] }])
    expect(bad[0].options).toEqual([{ value: 'a' }])
  })
  it('leaves non-optioned fields without an options key', () => {
    const [def] = normalizeSchema([{ name: 'title', type: 'text', primary: true }])
    expect('options' in def).toBe(false)
  })
})

describe('validateSchema', () => {
  const good: FieldDef[] = normalizeSchema([
    { name: 'title', type: 'text', primary: true },
    { name: 'status', type: 'status', options: ['open', 'done'] },
  ])

  it('passes a well-formed schema', () => {
    expect(validateSchema(good)).toEqual([])
  })
  it('requires exactly one primary text field', () => {
    expect(validateSchema(normalizeSchema([{ name: 'a', type: 'text' }]))).not.toEqual([])
    const two = normalizeSchema([
      { name: 'a', type: 'text', primary: true },
      { name: 'b', type: 'text', primary: true },
    ])
    expect(validateSchema(two).some(e => e.message.includes('exactly one'))).toBe(true)
  })
  it('rejects a non-text primary', () => {
    const s = normalizeSchema([
      { name: 'n', type: 'number', primary: true },
      { name: 't', type: 'text' },
    ])
    expect(validateSchema(s).some(e => e.field === 'n')).toBe(true)
  })
  it('rejects unknown types, duplicate names, empty schema', () => {
    expect(validateSchema([{ name: 'x', type: 'wat' as never }, { name: 't', type: 'text', primary: true }])
      .some(e => e.message.includes('unknown type'))).toBe(true)
    const dup = normalizeSchema([
      { name: 'title', type: 'text', primary: true },
      { name: 'Title', type: 'text' },
    ])
    expect(validateSchema(dup).some(e => e.message.includes('duplicate'))).toBe(true)
    expect(validateSchema([])).toEqual([{ field: '', message: 'schema must be a non-empty array of fields' }])
  })
  it('requires options for optioned types and rejects duplicate/empty option values', () => {
    const s = normalizeSchema([
      { name: 'title', type: 'text', primary: true },
      { name: 'sel', type: 'select' },
    ])
    expect(validateSchema(s).some(e => e.field === 'sel')).toBe(true)
    const dup = normalizeSchema([
      { name: 'title', type: 'text', primary: true },
      { name: 'sel', type: 'select', options: ['a', 'a'] },
    ])
    expect(validateSchema(dup).some(e => e.message.includes('duplicate option'))).toBe(true)
  })
  it('validates defaults against their own field', () => {
    const s = normalizeSchema([
      { name: 'title', type: 'text', primary: true },
      { name: 'sel', type: 'select', options: ['a'], default: 'zzz' },
    ])
    expect(validateSchema(s).some(e => e.message.includes('invalid default'))).toBe(true)
  })
})

describe('coerceItemData', () => {
  const schema: FieldDef[] = normalizeSchema([
    { name: 'title', type: 'text', primary: true },
    { name: 'status', type: 'status', options: ['open', { value: 'done', category: 'done' }] },
    { name: 'priority', type: 'priority', default: 'medium' },
    { name: 'due', type: 'date' },
  ])

  it('add: coerces, applies defaults, requires primary', () => {
    const r = coerceItemData(schema, { title: 'Ship it' }, { partial: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual({ title: 'Ship it', status: 'open', priority: 'medium' })
    }
    const missing = coerceItemData(schema, {}, { partial: false })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.errors[0].field).toBe('title')
  })

  it('rejects unknown fields naming the valid ones', () => {
    const r = coerceItemData(schema, { title: 'x', bogus: 1 }, { partial: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0].field).toBe('bogus')
      expect(r.errors[0].message).toContain('title, status, priority, due')
    }
  })

  it('update: touches only incoming keys, no defaults, no primary requirement', () => {
    const r = coerceItemData(schema, { due: '2026-08-01' }, { partial: true })
    expect(r).toEqual({ ok: true, data: { due: '2026-08-01' }, cleared: [] })
  })

  it('update: null clears a field', () => {
    const r = coerceItemData(schema, { due: null }, { partial: true })
    expect(r).toEqual({ ok: true, data: {}, cleared: ['due'] })
  })

  it('collects multiple errors with field names', () => {
    const r = coerceItemData(schema, { status: 'nope', due: 'someday' }, { partial: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map(e => e.field).sort()).toEqual(['due', 'status'])
  })
})

describe('issue key constants', () => {
  it('ISSUE_PREFIX_RE accepts 2-6 uppercase letters only', () => {
    expect(ISSUE_PREFIX_RE.test('BOND')).toBe(true)
    expect(ISSUE_PREFIX_RE.test('WP')).toBe(true)
    expect(ISSUE_PREFIX_RE.test('WOOSTR')).toBe(true)
    expect(ISSUE_PREFIX_RE.test('B')).toBe(false)
    expect(ISSUE_PREFIX_RE.test('TOOLONGX')).toBe(false)
    expect(ISSUE_PREFIX_RE.test('bond')).toBe(false)
  })
  it('ISSUE_KEY_RE finds candidate keys in text', () => {
    const text = 'see BOND-12 and WP-3, but not utf-8'
    const keys = [...text.matchAll(ISSUE_KEY_RE)].map(m => m[0])
    expect(keys).toEqual(['BOND-12', 'WP-3'])
  })
  it('parseIssueKey round-trips', () => {
    expect(parseIssueKey('BOND-42')).toEqual({ prefix: 'BOND', number: 42 })
    expect(parseIssueKey('nope')).toBeNull()
  })
})

describe('option helpers', () => {
  it('optionsOf and optionLabel', () => {
    expect(optionsOf(textDef)).toEqual([])
    expect(optionLabel({ value: 'a' })).toBe('a')
    expect(optionLabel({ value: 'a', label: 'Alpha' })).toBe('Alpha')
  })
})
