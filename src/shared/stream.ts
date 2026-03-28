export type BondStreamChunk =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'assistant_tool'; name: string; summary?: string }
  | { kind: 'system'; subtype: string; text?: string }
  | { kind: 'auth_status'; authenticating: boolean; lines: string[]; error?: string }
  | { kind: 'result'; subtype: string; result?: string; errors?: string[] }
  | { kind: 'raw_error'; message: string }
