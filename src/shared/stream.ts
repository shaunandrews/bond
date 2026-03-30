export type BondStreamChunk =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'thinking_text'; text: string }
  | { kind: 'assistant_tool'; name: string; summary?: string }
  | { kind: 'system'; subtype: string; text?: string }
  | { kind: 'auth_status'; authenticating: boolean; lines: string[]; error?: string }
  | { kind: 'result'; subtype: string; result?: string; errors?: string[] }
  | { kind: 'tool_approval'; requestId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string }
  | { kind: 'raw_error'; message: string }

/** Chunk tagged with a sessionId for routing to the correct chat in the renderer */
export type TaggedChunk = BondStreamChunk & { sessionId: string }
