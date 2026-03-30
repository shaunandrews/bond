export type { ModelId } from '../../shared/models'
export type { AttachedImage } from '../../shared/session'
import type { AttachedImage } from '../../shared/session'

export type Message =
  | { id: string; role: 'user'; text: string; images?: AttachedImage[] }
  | { id: string; role: 'bond'; text: string; streaming: boolean }
  | { id: string; role: 'meta'; kind: 'tool'; name: string; summary?: string }
  | { id: string; role: 'meta'; kind: 'error'; text: string }
  | { id: string; role: 'meta'; kind: 'approval'; requestId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string; status: 'pending' | 'approved' | 'denied' }
  | { id: string; role: 'meta'; kind: 'system'; text: string }
