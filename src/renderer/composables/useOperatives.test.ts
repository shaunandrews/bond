import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useOperatives } from './useOperatives'
import type { Operative } from '../../shared/operative'

function makeOperative(overrides: Partial<Operative> = {}): Operative {
  return {
    id: 'op1', name: 'Test', prompt: 'Do stuff', workingDir: '/tmp',
    status: 'queued', inputTokens: 0, outputTokens: 0, costUsd: 0,
    contextWindow: 0, createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function mockWindowBond() {
  const mock = {
    listOperatives: vi.fn().mockResolvedValue([]),
    spawnOperative: vi.fn().mockResolvedValue(makeOperative()),
    cancelOperative: vi.fn().mockResolvedValue({ ok: true }),
    removeOperative: vi.fn().mockResolvedValue({ ok: true }),
    clearOperatives: vi.fn().mockResolvedValue({ deleted: 0 }),
    onOperativeChanged: vi.fn().mockReturnValue(vi.fn()),
  }
  ;(window as any).bond = mock
  return mock
}

type UseOperativesReturn = ReturnType<typeof useOperatives>

function withSetup(): UseOperativesReturn {
  let result!: UseOperativesReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useOperatives()
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useOperatives', () => {
  let bond: ReturnType<typeof mockWindowBond>
  let ops: UseOperativesReturn

  beforeEach(() => {
    bond = mockWindowBond()
    ops = withSetup()
  })

  describe('initial load', () => {
    it('calls listOperatives on mount', () => {
      expect(bond.listOperatives).toHaveBeenCalled()
    })

    it('subscribes to operative changes', () => {
      expect(bond.onOperativeChanged).toHaveBeenCalled()
    })
  })

  describe('spawn', () => {
    it('adds operative and selects it', async () => {
      const newOp = makeOperative({ id: 'new-1', name: 'New' })
      bond.spawnOperative.mockResolvedValue(newOp)

      const result = await ops.spawn({ name: 'New', prompt: 'Go' })
      expect(result.name).toBe('New')
      expect(ops.operatives.value).toContainEqual(expect.objectContaining({ id: 'new-1' }))
      expect(ops.activeOperativeId.value).toBe('new-1')
    })
  })

  describe('cancel', () => {
    it('calls cancelOperative', async () => {
      await ops.cancel('op1')
      expect(bond.cancelOperative).toHaveBeenCalledWith('op1')
    })
  })

  describe('remove', () => {
    it('removes operative from list', async () => {
      ops.operatives.value = [makeOperative({ id: 'op1' })]
      ops.activeOperativeId.value = 'op1'

      await ops.remove('op1')
      expect(ops.operatives.value).toHaveLength(0)
      expect(ops.activeOperativeId.value).toBeNull()
    })
  })

  describe('select', () => {
    it('updates activeOperativeId', () => {
      ops.select('op1')
      expect(ops.activeOperativeId.value).toBe('op1')
    })
  })

  describe('computed', () => {
    it('activeOperative resolves from list', () => {
      ops.operatives.value = [makeOperative({ id: 'op1' })]
      ops.activeOperativeId.value = 'op1'
      expect(ops.activeOperative.value?.id).toBe('op1')
    })

    it('runningOperatives filters by status', () => {
      ops.operatives.value = [
        makeOperative({ id: 'a', status: 'running' }),
        makeOperative({ id: 'b', status: 'queued' }),
        makeOperative({ id: 'c', status: 'completed' }),
      ]
      expect(ops.runningOperatives.value).toHaveLength(1)
      expect(ops.queuedOperatives.value).toHaveLength(1)
      expect(ops.runningCount.value).toBe(2) // running + queued
    })
  })
})
