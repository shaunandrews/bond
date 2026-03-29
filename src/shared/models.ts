export const MODEL_IDS = ['opus', 'sonnet', 'haiku'] as const
export type ModelId = (typeof MODEL_IDS)[number]
