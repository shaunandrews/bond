import { describe, it, expect } from 'vitest'
import { zstdCompressSync, gzipSync } from 'node:zlib'
import { decodeBody, extractToolNames, isModelRequest } from './wire-debug'

describe('isModelRequest', () => {
  it('matches model hosts and rejects others', () => {
    expect(isModelRequest('https://chatgpt.com/backend-api/codex/responses')).toBe(true)
    expect(isModelRequest('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isModelRequest('https://api.openai.com/v1/responses')).toBe(true)
    expect(isModelRequest('https://example.com/tools')).toBe(false)
    expect(isModelRequest('not a url')).toBe(false)
  })
})

describe('decodeBody', () => {
  it('passes strings through', () => {
    expect(decodeBody('{"a":1}')).toBe('{"a":1}')
  })

  it('decompresses zstd bodies', () => {
    const body = zstdCompressSync(Buffer.from('{"tools":[]}'))
    expect(decodeBody(new Uint8Array(body))).toBe('{"tools":[]}')
  })

  it('decompresses gzip bodies', () => {
    const body = gzipSync(Buffer.from('{"tools":[]}'))
    expect(decodeBody(new Uint8Array(body))).toBe('{"tools":[]}')
  })

  it('returns null for undecodable input', () => {
    expect(decodeBody(undefined)).toBeNull()
    expect(decodeBody(42)).toBeNull()
  })
})

describe('describeWsFrame', () => {
  it('describes a full response.create frame with tools', async () => {
    const { describeWsFrame } = await import('./wire-debug')
    const frame = JSON.stringify({ type: 'response.create', tools: [{ name: 'web_search' }, { name: 'read' }] })
    expect(describeWsFrame(frame)).toBe('ws tools (full): ["web_search","read"]')
  })

  it('flags delta frames and missing tools fields', async () => {
    const { describeWsFrame } = await import('./wire-debug')
    const delta = JSON.stringify({ type: 'response.create', previous_response_id: 'r1', tools: [{ name: 'bash' }] })
    expect(describeWsFrame(delta)).toBe('ws tools (delta): ["bash"]')
    const bare = JSON.stringify({ type: 'response.create', input: [] })
    expect(describeWsFrame(bare)).toBe('ws tools (full): NO tools field')
  })

  it('ignores non-model frames', async () => {
    const { describeWsFrame } = await import('./wire-debug')
    expect(describeWsFrame('{"type":"ping"}')).toBeNull()
    expect(describeWsFrame(new Uint8Array([1, 2]))).toBeNull()
  })
})

describe('extractToolNames', () => {
  it('reads plain function-tool names', () => {
    const body = JSON.stringify({ tools: [{ name: 'web_search' }, { function: { name: 'read' } }, { type: 'web_search_preview' }] })
    expect(extractToolNames(body)).toEqual(['web_search', 'read', 'web_search_preview'])
  })

  it('reads names out of a zstd-compressed body', () => {
    const body = zstdCompressSync(Buffer.from(JSON.stringify({ tools: [{ name: 'fetch_content' }] })))
    expect(extractToolNames(new Uint8Array(body))).toEqual(['fetch_content'])
  })

  it('returns null when there is no tools array', () => {
    expect(extractToolNames(JSON.stringify({ messages: [] }))).toBeNull()
    expect(extractToolNames('not json')).toBeNull()
  })
})
