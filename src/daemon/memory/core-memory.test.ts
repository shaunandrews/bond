import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCoreMemory, updateCoreMemory, withCoreMemoryLock, writeCoreMemoryAtomic } from './core-memory'

describe('core memory', () => {
  it('writes core memory atomically and leaves no temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bond-core-memory-'))
    try {
      const path = join(dir, 'nested', 'core.json')
      const written = writeCoreMemoryAtomic({
        version: 1,
        facts: ['fact'],
        preferences: ['pref'],
        decisions: ['decision'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }, path)

      expect(written.facts).toEqual(['fact'])
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(written)
      expect(readdirSync(join(dir, 'nested')).filter(name => name.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty memory when the file is missing or invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bond-core-memory-'))
    try {
      const missing = readCoreMemory(join(dir, 'missing.json'))
      expect(missing.version).toBe(1)
      expect(missing.facts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serializes asynchronous core mutations', async () => {
    const order: string[] = []
    const first = withCoreMemoryLock(async () => {
      order.push('first-start')
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('first-end')
    })
    const second = withCoreMemoryLock(() => { order.push('second') })

    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('updates via read-modify-atomic-write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bond-core-memory-'))
    try {
      const path = join(dir, 'core.json')
      const next = updateCoreMemory(current => ({ ...current, facts: ['new'] }), path)
      expect(next.facts).toEqual(['new'])
      expect(readCoreMemory(path).facts).toEqual(['new'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
