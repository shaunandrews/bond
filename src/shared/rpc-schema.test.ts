import { describe, it, expect } from 'vitest'
import { RPC_METHOD_NAMES } from './rpc-schema'

describe('rpc-schema', () => {
  it('has no duplicate method names', () => {
    const unique = new Set(RPC_METHOD_NAMES)
    expect(unique.size).toBe(RPC_METHOD_NAMES.length)
  })

  it('every method name is namespace.method shaped', () => {
    for (const name of RPC_METHOD_NAMES) {
      expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
    }
  })
})
