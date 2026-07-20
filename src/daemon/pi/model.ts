/**
 * Capability-tier → concrete-model resolution against the models Pi's
 * connected subscriptions actually offer. Shared by the main Bond turn
 * (runtime.ts) and standalone sessions (Felix, text prompts) — extracted so
 * those callers don't import runtime.ts and create a module cycle.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { normalizeModelTier, type ModelId } from '../../shared/models'

export const ANTHROPIC_MODEL_IDS: Record<ModelId, string> = {
  high: 'claude-opus-4-6',
  balanced: 'claude-sonnet-4-5',
  fast: 'claude-haiku-4-5',
}

export const CODEX_MODEL_IDS: Record<ModelId, string> = {
  high: 'gpt-5.6-terra',
  balanced: 'gpt-5.5',
  fast: 'gpt-5.4-mini',
}

export interface AvailableModelLike {
  provider: string
  id: string
}

/** Pure tier resolution: Anthropic first, then the Codex tier, then any Codex model. */
export function pickModel<T extends AvailableModelLike>(available: readonly T[], tier: ModelId): T | undefined {
  return available.find(model => model.provider === 'anthropic' && model.id === ANTHROPIC_MODEL_IDS[tier])
    ?? available.find(model => model.provider === 'openai-codex' && model.id === CODEX_MODEL_IDS[tier])
    ?? available.find(model => model.provider === 'openai-codex')
}

export async function selectModel(name: string | undefined) {
  const runtime = await ModelRuntime.create()
  const picked = pickModel(await runtime.getAvailable(), normalizeModelTier(name))
  if (!picked) throw new Error('No authenticated Claude or ChatGPT subscription is available in Pi.')
  return { model: picked, modelRuntime: runtime }
}
