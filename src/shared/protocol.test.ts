import { describe, it, expect } from 'vitest'
import {
  makeRequest, makeResponse, makeErrorResponse, makeNotification,
  isRequest, isResponse, isNotification,
  RPC_PARSE_ERROR, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS, RPC_INTERNAL_ERROR,
} from './protocol'

describe('protocol module', () => {
  describe('makeRequest', () => {
    it('creates a valid JSON-RPC request', () => {
      const req = makeRequest(1, 'bond.send', { text: 'hello' })
      expect(req).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'bond.send',
        params: { text: 'hello' },
      })
    })

    it('works with string id', () => {
      const req = makeRequest('abc', 'test')
      expect(req.id).toBe('abc')
    })

    it('omits params when undefined', () => {
      const req = makeRequest(1, 'test')
      expect(req.params).toBeUndefined()
    })
  })

  describe('makeResponse', () => {
    it('creates a success response', () => {
      const res = makeResponse(1, { ok: true })
      expect(res).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true },
      })
    })

    it('handles null result', () => {
      const res = makeResponse(1, null)
      expect(res.result).toBeNull()
    })
  })

  describe('makeErrorResponse', () => {
    it('creates an error response', () => {
      const res = makeErrorResponse(1, RPC_METHOD_NOT_FOUND, 'Not found')
      expect(res).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Not found' },
      })
    })

    it('includes data when provided', () => {
      const res = makeErrorResponse(1, RPC_INTERNAL_ERROR, 'Oops', { detail: 'stack' })
      expect(res.error?.data).toEqual({ detail: 'stack' })
    })
  })

  describe('makeNotification', () => {
    it('creates a notification (no id)', () => {
      const n = makeNotification('bond.chunk', { text: 'hi' })
      expect(n).toEqual({
        jsonrpc: '2.0',
        method: 'bond.chunk',
        params: { text: 'hi' },
      })
      expect('id' in n).toBe(false)
    })
  })

  describe('type guards', () => {
    it('isRequest identifies requests', () => {
      const req = makeRequest(1, 'test')
      expect(isRequest(req)).toBe(true)
      expect(isResponse(req)).toBe(false)
      expect(isNotification(req)).toBe(false)
    })

    it('isResponse identifies responses', () => {
      const res = makeResponse(1, 'ok')
      expect(isResponse(res)).toBe(true)
      expect(isRequest(res)).toBe(false)
      expect(isNotification(res)).toBe(false)
    })

    it('isResponse identifies error responses', () => {
      const res = makeErrorResponse(1, -32600, 'Bad')
      expect(isResponse(res)).toBe(true)
    })

    it('isNotification identifies notifications', () => {
      const n = makeNotification('event')
      expect(isNotification(n)).toBe(true)
      expect(isRequest(n)).toBe(false)
      expect(isResponse(n)).toBe(false)
    })
  })

  describe('error codes', () => {
    it('has correct standard values', () => {
      expect(RPC_PARSE_ERROR).toBe(-32700)
      expect(RPC_INVALID_REQUEST).toBe(-32600)
      expect(RPC_METHOD_NOT_FOUND).toBe(-32601)
      expect(RPC_INVALID_PARAMS).toBe(-32602)
      expect(RPC_INTERNAL_ERROR).toBe(-32603)
    })
  })
})
