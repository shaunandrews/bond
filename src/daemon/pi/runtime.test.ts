import { describe, expect, it } from 'vitest'
import { piEventToChunks } from './runtime'

describe('piEventToChunks', () => {
  it('preserves renderer text and thinking chunks', () => {
    expect(piEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }))
      .toEqual([{ kind: 'assistant_text', text: 'Hello' }])
    expect(piEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm' } }))
      .toEqual([{ kind: 'thinking_text', text: 'Hmm' }])
  })

  it('maps Pi tool lifecycle events to Bond chunks', () => {
    expect(piEventToChunks({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'call-1', args: { path: '/tmp/a.txt' } }))
      .toEqual([{ kind: 'assistant_tool', name: 'read', summary: '/tmp/a.txt', input: { path: '/tmp/a.txt' }, toolUseId: 'call-1' }])
    expect(piEventToChunks({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'call-1', result: 'contents', isError: false }))
      .toEqual([{ kind: 'tool_result', toolName: 'read', toolUseId: 'call-1', output: 'contents', isError: false }])
  })

  it('maps retry status and ignores unrelated events', () => {
    expect(piEventToChunks({ type: 'auto_retry_start', errorMessage: 'rate limited' }))
      .toEqual([{ kind: 'system', subtype: 'api_retry', text: 'rate limited' }])
    expect(piEventToChunks({ type: 'agent_start' })).toEqual([])
  })
})
