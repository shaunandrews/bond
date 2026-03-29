import { describe, it, expect } from 'vitest'
import { bondMessageToChunks } from './agent'

// Minimal SDKMessage-shaped objects for testing

function streamEvent(delta: { type: string; text?: string }) {
  return {
    type: 'stream_event' as const,
    event: { type: 'content_block_delta', index: 0, delta },
    parent_tool_use_id: null,
    uuid: 'test-uuid',
    session_id: 'test-session',
  }
}

function assistantMessage(content: Array<Record<string, unknown>>) {
  return {
    type: 'assistant' as const,
    message: { content },
  }
}

describe('bondMessageToChunks', () => {
  describe('stream_event handling', () => {
    it('yields assistant_text for text_delta events', () => {
      const msg = streamEvent({ type: 'text_delta', text: 'Hello' })
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([{ kind: 'assistant_text', text: 'Hello' }])
    })

    it('ignores non-text deltas', () => {
      const msg = streamEvent({ type: 'input_json_delta' })
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([])
    })

    it('ignores non-content_block_delta stream events', () => {
      const msg = {
        type: 'stream_event' as const,
        event: { type: 'message_start' },
        parent_tool_use_id: null,
        uuid: 'test-uuid',
        session_id: 'test-session',
      }
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([])
    })
  })

  describe('complete assistant messages', () => {
    it('skips text blocks (already streamed via deltas)', () => {
      const msg = assistantMessage([
        { type: 'text', text: 'This should be skipped' },
      ])
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([])
    })

    it('still yields tool_use blocks', () => {
      const msg = assistantMessage([
        { type: 'text', text: 'Some text' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test.txt' } },
      ])
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([
        { kind: 'assistant_tool', name: 'Read', summary: '/tmp/test.txt' },
      ])
    })
  })

  describe('result messages', () => {
    it('yields success result', () => {
      const msg = { type: 'result' as const, subtype: 'success', result: 'done' }
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([{ kind: 'result', subtype: 'success', result: 'done' }])
    })

    it('yields error result', () => {
      const msg = { type: 'result' as const, subtype: 'error', errors: ['fail'] }
      const chunks = [...bondMessageToChunks(msg as any)]
      expect(chunks).toEqual([{ kind: 'result', subtype: 'error', errors: ['fail'] }])
    })
  })
})
