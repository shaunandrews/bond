export type { ModelId } from '../../shared/models'

export type Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'bond'; text: string; streaming: boolean }
  | { id: string; role: 'meta'; kind: 'tool'; name: string; summary?: string }
  | { id: string; role: 'meta'; kind: 'error'; text: string }
  | { id: string; role: 'meta'; kind: 'system'; text: string }
