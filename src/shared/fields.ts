/**
 * Field-type registry — the single source of truth for how collection field
 * values are coerced, validated, formatted, compared, and defaulted.
 *
 * Shared by the daemon (write-path enforcement), the renderer (render/edit/
 * sort), and the CLI (parse/format). Same contract-in-one-place pattern as
 * rpc-schema.ts: adding a FieldType without a registry entry is a compile
 * error.
 *
 * Layering: pure functions only, imports only from session.ts.
 */
import type {
  FieldColor,
  FieldDef,
  FieldDefInput,
  FieldOption,
  FieldType,
  StatusCategory,
} from './session'

export interface FieldError {
  field: string
  message: string
}

export type CoerceResult =
  | { ok: true; value: unknown } // value === undefined means "not set"
  | { ok: false; error: string }

export interface FieldTypeDef {
  /**
   * Lenient: accepts canonical values AND common inputs (strings from CLI
   * flags and forms, numbers, arrays). Never throws. undefined/'' → not set.
   */
  coerce(raw: unknown, def: FieldDef): CoerceResult
  /** Strict: canonical value → error string | null. */
  validate(value: unknown, def: FieldDef): string | null
  /** Plain-text display. Total over garbage — never throws. */
  format(value: unknown, def: FieldDef): string
  /** Canonical-value comparator; callers handle null/undefined ordering. */
  compare(a: unknown, b: unknown, def: FieldDef): number
  /** Resolved default for new items (honors def.default, else type default). */
  defaultValue(def: FieldDef): unknown
}

// --- Shared constants ---

export const STATUS_CATEGORIES: readonly StatusCategory[] = ['open', 'active', 'done', 'cancelled']
export const FIELD_COLORS: readonly FieldColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']

/** Canonical priority set applied when a priority field declares no options. Rank = array index (most urgent first). */
export const DEFAULT_PRIORITY_OPTIONS: readonly FieldOption[] = [
  { value: 'urgent', color: 'red' },
  { value: 'high', color: 'orange' },
  { value: 'medium', color: 'yellow' },
  { value: 'low', color: 'blue' },
  { value: 'none', color: 'gray' },
]

/** Default colors per status category, used when a status option declares none. */
const STATUS_CATEGORY_COLORS: Record<StatusCategory, FieldColor> = {
  open: 'gray',
  active: 'blue',
  done: 'green',
  cancelled: 'red',
}

/** Tracker key prefix shape (e.g. BOND, WP, WOOSTR). */
export const ISSUE_PREFIX_RE = /^[A-Z]{2,6}$/
/** Candidate issue keys in free text. Consumers MUST still gate on known prefixes ("UTF-8" matches). */
export const ISSUE_KEY_RE = /\b([A-Z]{2,6})-(\d+)\b/g

export function parseIssueKey(text: string): { prefix: string; number: number } | null {
  const m = /^([A-Z]{2,6})-(\d+)$/.exec(text.trim())
  return m ? { prefix: m[1], number: parseInt(m[2], 10) } : null
}

// --- Option helpers ---

const OPTIONED_TYPES: readonly FieldType[] = ['select', 'multiselect', 'status', 'priority']

export function isOptionedType(type: FieldType): boolean {
  return OPTIONED_TYPES.includes(type)
}

/** Canonical options of a field def ([] when none/not an optioned type). */
export function optionsOf(def: FieldDef): FieldOption[] {
  return def.options ?? []
}

export function optionLabel(opt: FieldOption): string {
  return opt.label ?? opt.value
}

function findOption(def: FieldDef, value: unknown): FieldOption | undefined {
  return optionsOf(def).find(o => o.value === value)
}

function optionValues(def: FieldDef): string[] {
  return optionsOf(def).map(o => o.value)
}

function optionMembershipError(def: FieldDef, value: string): string | null {
  if (!findOption(def, value)) {
    return `"${value}" is not an option — must be one of: ${optionValues(def).join(', ')}`
  }
  return null
}

/** True when a status field's value sits in a done-like category (done/cancelled). */
export function isDoneValue(def: FieldDef, value: unknown): boolean {
  if (def.type !== 'status') return false
  const opt = findOption(def, value)
  return opt?.category === 'done' || opt?.category === 'cancelled'
}

// --- Per-type coercion/validation primitives ---

function notSet(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === ''
}

function coerceString(raw: unknown): CoerceResult {
  if (notSet(raw)) return { ok: true, value: undefined }
  if (typeof raw === 'string') return { ok: true, value: raw }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw) }
  return { ok: false, error: 'expected text' }
}

function coerceNumber(raw: unknown): CoerceResult {
  if (notSet(raw)) return { ok: true, value: undefined }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n)) return { ok: false, error: `"${String(raw)}" is not a number` }
  return { ok: true, value: n }
}

const TRUE_WORDS = new Set(['true', 'yes', '1', 'on', 'y'])
const FALSE_WORDS = new Set(['false', 'no', '0', 'off', 'n'])

function coerceBoolean(raw: unknown): CoerceResult {
  if (notSet(raw)) return { ok: true, value: undefined }
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  if (typeof raw === 'number') return { ok: true, value: raw !== 0 }
  if (typeof raw === 'string') {
    const w = raw.trim().toLowerCase()
    if (TRUE_WORDS.has(w)) return { ok: true, value: true }
    if (FALSE_WORDS.has(w)) return { ok: true, value: false }
  }
  return { ok: false, error: `"${String(raw)}" is not a yes/no value` }
}

function coerceStringArray(raw: unknown): CoerceResult {
  if (notSet(raw)) return { ok: true, value: undefined }
  if (Array.isArray(raw)) {
    if (!raw.every(v => typeof v === 'string' || typeof v === 'number')) {
      return { ok: false, error: 'expected a list of text values' }
    }
    const arr = raw.map(v => String(v).trim()).filter(Boolean)
    return { ok: true, value: arr.length ? arr : undefined }
  }
  if (typeof raw === 'string') {
    const arr = raw.split(',').map(s => s.trim()).filter(Boolean)
    return { ok: true, value: arr.length ? arr : undefined }
  }
  return { ok: false, error: 'expected a list of text values' }
}

/** YYYY-MM-DD, with a real calendar check (rejects 2026-02-30). */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function coerceDate(raw: unknown): CoerceResult {
  if (notSet(raw)) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, error: 'expected a date (YYYY-MM-DD)' }
  const s = raw.trim()
  const m = DATE_RE.exec(s)
  if (!m) {
    // Tolerate full ISO timestamps by truncating to the date part
    const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(s)
    if (iso) return coerceDate(iso[1])
    return { ok: false, error: `"${s}" is not a date — use YYYY-MM-DD` }
  }
  const [, y, mo, d] = m
  const dt = new Date(Date.UTC(+y, +mo - 1, +d))
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    return { ok: false, error: `"${s}" is not a valid calendar date` }
  }
  return { ok: true, value: s }
}

function compareNumbers(a: unknown, b: unknown): number {
  return (typeof a === 'number' ? a : 0) - (typeof b === 'number' ? b : 0)
}

function compareStrings(a: unknown, b: unknown): number {
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' })
}

function formatPlain(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(v => String(v)).join(', ')
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '[object]' }
  }
  return String(value)
}

// --- Type definitions ---

const textType: FieldTypeDef = {
  coerce: coerceString,
  validate: v => (typeof v === 'string' ? null : 'expected text'),
  format: formatPlain,
  compare: compareStrings,
  defaultValue: def => def.default,
}

const numberType: FieldTypeDef = {
  coerce: coerceNumber,
  validate: v => (typeof v === 'number' && Number.isFinite(v) ? null : 'expected a number'),
  format: (v, def) => {
    if (v === null || v === undefined) return ''
    return `${def.prefix ?? ''}${formatPlain(v)}${def.suffix ?? ''}`
  },
  compare: compareNumbers,
  defaultValue: def => def.default,
}

const dateType: FieldTypeDef = {
  coerce: coerceDate,
  validate: v => (typeof v === 'string' && DATE_RE.test(v) ? null : 'expected a date (YYYY-MM-DD)'),
  format: formatPlain,
  compare: compareStrings,
  defaultValue: def => def.default,
}

const booleanType: FieldTypeDef = {
  coerce: coerceBoolean,
  validate: v => (typeof v === 'boolean' ? null : 'expected a yes/no value'),
  format: v => (v === true ? 'Yes' : v === false ? 'No' : ''),
  compare: (a, b) => (a === true ? 1 : 0) - (b === true ? 1 : 0),
  defaultValue: def => def.default,
}

function makeSingleOptionType(): FieldTypeDef {
  return {
    coerce: (raw, def) => {
      const c = coerceString(raw)
      if (!c.ok || c.value === undefined) return c
      const s = (c.value as string).trim()
      if (!s) return { ok: true, value: undefined }
      // Case-insensitive match to the canonical option value
      const match = optionsOf(def).find(o => o.value.toLowerCase() === s.toLowerCase())
      if (!match) return { ok: false, error: optionMembershipError(def, s) ?? 'invalid option' }
      return { ok: true, value: match.value }
    },
    validate: (v, def) => (typeof v === 'string' ? optionMembershipError(def, v) : 'expected an option value'),
    format: (v, def) => {
      const opt = findOption(def, v)
      return opt ? optionLabel(opt) : formatPlain(v)
    },
    // Order by option position — meaningful for status workflows and priority rank
    compare: (a, b, def) => {
      const values = optionValues(def)
      return values.indexOf(String(a)) - values.indexOf(String(b))
    },
    defaultValue: def => def.default ?? undefined,
  }
}

const selectType = makeSingleOptionType()
const priorityType = makeSingleOptionType()
const statusType: FieldTypeDef = {
  ...makeSingleOptionType(),
  // New items land on the first option (by convention the initial workflow state)
  defaultValue: def => def.default ?? optionsOf(def)[0]?.value,
}

const multiselectType: FieldTypeDef = {
  coerce: (raw, def) => {
    const c = coerceStringArray(raw)
    if (!c.ok || c.value === undefined) return c
    const resolved: string[] = []
    for (const s of c.value as string[]) {
      const match = optionsOf(def).find(o => o.value.toLowerCase() === s.toLowerCase())
      if (!match) return { ok: false, error: optionMembershipError(def, s) ?? 'invalid option' }
      resolved.push(match.value)
    }
    return { ok: true, value: resolved }
  },
  validate: (v, def) => {
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return 'expected a list of option values'
    for (const x of v) {
      const err = optionMembershipError(def, x)
      if (err) return err
    }
    return null
  },
  format: (v, def) => {
    if (!Array.isArray(v)) return formatPlain(v)
    return v.map(x => {
      const opt = findOption(def, x)
      return opt ? optionLabel(opt) : String(x)
    }).join(', ')
  },
  compare: (a, b) => compareStrings(formatPlain(a), formatPlain(b)),
  defaultValue: def => def.default,
}

const ratingType: FieldTypeDef = {
  coerce: (raw, def) => {
    const c = coerceNumber(raw)
    if (!c.ok || c.value === undefined) return c
    const max = def.max ?? 5
    const n = c.value as number
    if (!Number.isInteger(n) || n < 0 || n > max) {
      return { ok: false, error: `rating must be a whole number between 0 and ${max}` }
    }
    return c
  },
  validate: (v, def) => {
    const max = def.max ?? 5
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
      ? null
      : `expected a whole number between 0 and ${max}`
  },
  format: (v, def) => {
    if (typeof v !== 'number') return formatPlain(v)
    const max = def.max ?? 5
    const n = Math.max(0, Math.min(max, Math.round(v)))
    return '★'.repeat(n) + '☆'.repeat(Math.max(0, max - n))
  },
  compare: compareNumbers,
  defaultValue: def => def.default,
}

const urlType: FieldTypeDef = {
  coerce: raw => {
    const c = coerceString(raw)
    if (!c.ok || c.value === undefined) return c
    const s = (c.value as string).trim()
    if (!s) return { ok: true, value: undefined }
    if (!/^https?:\/\/\S+$/i.test(s)) return { ok: false, error: `"${s}" is not a URL — must start with http:// or https://` }
    return { ok: true, value: s }
  },
  validate: v => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v) ? null : 'expected a http(s) URL'),
  format: formatPlain,
  compare: compareStrings,
  defaultValue: def => def.default,
}

const tagsType: FieldTypeDef = {
  coerce: raw => coerceStringArray(raw),
  validate: v => (Array.isArray(v) && v.every(x => typeof x === 'string') ? null : 'expected a list of tags'),
  format: formatPlain,
  compare: (a, b) => compareStrings(formatPlain(a), formatPlain(b)),
  defaultValue: def => def.default,
}

export const FIELD_TYPES: Record<FieldType, FieldTypeDef> = {
  text: textType,
  longtext: textType,
  number: numberType,
  date: dateType,
  boolean: booleanType,
  select: selectType,
  multiselect: multiselectType,
  rating: ratingType,
  url: urlType,
  tags: tagsType,
  image: textType, // stored as an image id/path string
  status: statusType,
  priority: priorityType,
}

export const FIELD_TYPE_NAMES = Object.keys(FIELD_TYPES) as readonly FieldType[]

// --- Null-safe convenience wrappers ---

export function formatFieldValue(value: unknown, def: FieldDef): string {
  const t = FIELD_TYPES[def.type]
  if (!t) return formatPlain(value)
  try {
    return t.format(value, def)
  } catch {
    return formatPlain(value)
  }
}

/** null/undefined sort last regardless of direction being applied by the caller. */
export function compareFieldValues(a: unknown, b: unknown, def: FieldDef): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const t = FIELD_TYPES[def.type]
  if (!t) return compareStrings(formatPlain(a), formatPlain(b))
  try {
    return t.compare(a, b, def)
  } catch {
    return 0
  }
}

// --- Schema normalization (legacy string[] options → FieldOption[]) ---

function normalizeOption(raw: string | FieldOption, type: FieldType): FieldOption {
  const opt: FieldOption = typeof raw === 'string' ? { value: raw } : { ...raw }
  if (type === 'status') {
    if (!opt.category || !STATUS_CATEGORIES.includes(opt.category)) opt.category = 'open'
    if (!opt.color) opt.color = STATUS_CATEGORY_COLORS[opt.category]
  }
  if (opt.color && !FIELD_COLORS.includes(opt.color)) delete opt.color
  return opt
}

/**
 * Wire/DB schema → canonical FieldDef[]. Tolerates legacy `string[]` options
 * and fills defaults (status categories/colors, priority default set).
 * Does NOT validate — pair with validateSchema on write paths.
 */
export function normalizeSchema(schema: FieldDefInput[]): FieldDef[] {
  return schema.map(def => {
    const out: FieldDef = { ...def, options: undefined }
    if (def.options) {
      out.options = def.options.map(o => normalizeOption(o, def.type))
    } else if (def.type === 'priority') {
      out.options = DEFAULT_PRIORITY_OPTIONS.map(o => ({ ...o }))
    }
    if (out.options === undefined) delete out.options
    return out
  })
}

// --- Schema validation (collection create/update) ---

export function validateSchema(schema: FieldDef[]): FieldError[] {
  const errors: FieldError[] = []
  if (!Array.isArray(schema) || schema.length === 0) {
    return [{ field: '', message: 'schema must be a non-empty array of fields' }]
  }

  const seen = new Set<string>()
  for (const def of schema) {
    const field = typeof def?.name === 'string' ? def.name : ''
    if (!def || typeof def.name !== 'string' || !def.name.trim()) {
      errors.push({ field, message: 'every field needs a non-empty name' })
      continue
    }
    const key = def.name.toLowerCase()
    if (seen.has(key)) errors.push({ field: def.name, message: 'duplicate field name' })
    seen.add(key)

    if (!FIELD_TYPES[def.type]) {
      errors.push({ field: def.name, message: `unknown type "${String(def.type)}" — valid types: ${FIELD_TYPE_NAMES.join(', ')}` })
      continue
    }
    if (isOptionedType(def.type)) {
      const opts = optionsOf(def)
      if (opts.length === 0) {
        errors.push({ field: def.name, message: `${def.type} fields need a non-empty options list` })
      } else {
        const optSeen = new Set<string>()
        for (const o of opts) {
          if (!o.value || !o.value.trim()) errors.push({ field: def.name, message: 'option values must be non-empty' })
          if (optSeen.has(o.value)) errors.push({ field: def.name, message: `duplicate option "${o.value}"` })
          optSeen.add(o.value)
        }
      }
    }
    if (def.type === 'rating' && def.max !== undefined && (!Number.isInteger(def.max) || def.max < 1)) {
      errors.push({ field: def.name, message: 'rating max must be a whole number >= 1' })
    }
    if (def.primary && def.type !== 'text') {
      errors.push({ field: def.name, message: 'the primary field must be a text field' })
    }
    // A default must satisfy its own field's validation, or it becomes a bypass
    if (def.default !== undefined && def.default !== null) {
      const c = FIELD_TYPES[def.type].coerce(def.default, def)
      if (!c.ok) errors.push({ field: def.name, message: `invalid default: ${c.error}` })
      else if (c.value !== undefined) {
        const err = FIELD_TYPES[def.type].validate(c.value, def)
        if (err) errors.push({ field: def.name, message: `invalid default: ${err}` })
      }
    }
  }

  const primaries = schema.filter(f => f?.primary)
  if (primaries.length !== 1) {
    errors.push({ field: '', message: `exactly one text field must be marked "primary": true (found ${primaries.length})` })
  }
  return errors
}

// --- Item data coercion (the single write-path gate) ---

export type CoerceItemResult =
  | { ok: true; data: Record<string, unknown>; cleared: string[] }
  | { ok: false; errors: FieldError[] }

/**
 * Validate + coerce incoming item data against a canonical schema.
 *
 * partial=false (add): applies field defaults, requires a non-empty primary.
 * partial=true (update): touches only incoming keys; `null` clears a field
 * (returned in `cleared` — the caller deletes those keys after merging).
 * Unknown keys are always rejected, naming the valid fields.
 */
export function coerceItemData(
  schema: FieldDef[],
  data: Record<string, unknown>,
  opts: { partial: boolean }
): CoerceItemResult {
  const errors: FieldError[] = []
  const out: Record<string, unknown> = {}
  const cleared: string[] = []
  const byName = new Map(schema.map(f => [f.name, f]))

  for (const [key, raw] of Object.entries(data)) {
    const def = byName.get(key)
    if (!def) {
      errors.push({ field: key, message: `unknown field — valid fields: ${schema.map(f => f.name).join(', ')}` })
      continue
    }
    if (raw === null) {
      if (opts.partial) cleared.push(key)
      continue
    }
    const c = FIELD_TYPES[def.type].coerce(raw, def)
    if (!c.ok) {
      errors.push({ field: key, message: c.error })
      continue
    }
    if (c.value === undefined) {
      if (opts.partial) cleared.push(key)
      continue
    }
    const err = FIELD_TYPES[def.type].validate(c.value, def)
    if (err) {
      errors.push({ field: key, message: err })
      continue
    }
    out[key] = c.value
  }

  if (!opts.partial) {
    for (const def of schema) {
      if (out[def.name] !== undefined) continue
      const dv = FIELD_TYPES[def.type].defaultValue(def)
      if (dv === undefined || dv === null) continue
      const c = FIELD_TYPES[def.type].coerce(dv, def)
      if (c.ok && c.value !== undefined && !FIELD_TYPES[def.type].validate(c.value, def)) {
        out[def.name] = c.value
      }
    }
    const primary = schema.find(f => f.primary)
    if (primary && (out[primary.name] === undefined || String(out[primary.name]).trim() === '')) {
      errors.push({ field: primary.name, message: 'the primary field is required' })
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, data: out, cleared }
}
