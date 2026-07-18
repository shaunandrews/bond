/** Provider-neutral capability tiers. Pi resolves these against the connected subscription. */
export const MODEL_IDS = ['high', 'balanced', 'fast'] as const
export type ModelId = (typeof MODEL_IDS)[number]
