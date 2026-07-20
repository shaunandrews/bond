import { FIELD_COLORS } from '../../shared/fields'
import type { FieldDef, FieldOption } from '../../shared/session'

/** Named palette key → CSS custom property (null for unknown/absent keys). */
export function fieldColorVar(color?: string): string | null {
  return color && (FIELD_COLORS as readonly string[]).includes(color) ? `var(--field-${color})` : null
}

/** Resolved CSS color for an option's stored palette key. */
export function optionColorVar(def: FieldDef, value: unknown): string | null {
  const opt = (def.options ?? []).find((o: FieldOption) => o.value === value)
  return fieldColorVar(opt?.color)
}
