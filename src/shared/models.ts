/** Provider-neutral capability tiers. Pi resolves these against the connected subscription. */
export const MODEL_IDS = ['high', 'balanced', 'fast'] as const
export type ModelId = (typeof MODEL_IDS)[number]

/**
 * Normalize a stored model value to a ModelId. Preserves choices saved before
 * provider names were removed from the product UI (opus/sonnet/haiku), passes
 * valid tiers through, and falls back to 'balanced' for anything else.
 */
export function normalizeModelTier(value: string | undefined): ModelId {
  if (value === 'opus') return 'high'
  if (value === 'sonnet') return 'balanced'
  if (value === 'haiku') return 'fast'
  return value && (MODEL_IDS as readonly string[]).includes(value) ? (value as ModelId) : 'balanced'
}
