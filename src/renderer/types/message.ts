export type { ModelId } from '../../shared/models'
export type { AttachedImage } from '../../shared/session'
import type { AttachedImage } from '../../shared/session'

type BaseMsg = { id: string; ts?: number }

export type Message =
  | BaseMsg & { role: 'user'; text: string; images?: AttachedImage[]; imageIds?: string[] }
  | BaseMsg & { role: 'bond'; text: string; streaming: boolean }
  | BaseMsg & { role: 'meta'; kind: 'tool'; name: string; summary?: string }
  | BaseMsg & { role: 'meta'; kind: 'skill'; name: string; args?: string }
  | BaseMsg & { role: 'meta'; kind: 'thinking'; text: string; durationSec?: number; streaming: boolean }
  | BaseMsg & { role: 'meta'; kind: 'error'; text: string }
  | BaseMsg & { role: 'meta'; kind: 'approval'; requestId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string; status: 'pending' | 'approved' | 'denied' }
  | BaseMsg & { role: 'meta'; kind: 'system'; text: string }
