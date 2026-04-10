import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, ref, nextTick } from 'vue'
import { useOperativeEvents } from './useOperativeEvents'
import type { OperativeEvent } from '../../shared/operative'

function makeEvent(overrides: Partial<OperativeEvent> = {}): OperativeEvent {
  return {
    id: 1, operativeId: 'op1', kind: 'text',
    data: { text: 'hello' }, createdAt: '2025-01-01',
    ...overrides,
  }
}

function mockWindowBond() {
  const eventListeners: Array<(payload: { operativeId: string; event: OperativeEvent }) => void> = []
  const mock = {
    getOperativeEvents: vi.fn().mockResolvedValue([]),
    onOperativeEvent: vi.fn((fn: (payload: { operativeId: string; event: OperativeEvent }) => void) => {
      eventListeners.push(fn)
      return () => {
        const idx = eventListeners.indexOf(fn)
        if (idx !== -1) eventListeners.splice(idx, 1)
      }
    }),
  }
  ;(window as any).bond = mock
  return { mock, eventListeners }
}

type UseOperativeEventsReturn = ReturnType<typeof useOperativeEvents>

function withSetup(operativeId: ReturnType<typeof ref<string | null>>): UseOperativeEventsReturn {
  let result!: UseOperativeEventsReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useOperativeEvents(operativeId)
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useOperativeEvents', () => {
  let bond: ReturnType<typeof mockWindowBond>

  beforeEach(() => {
    bond = mockWindowBond()
  })

  it('loads events on mount when operativeId is set', async () => {
    const id = ref<string | null>('op1')
    const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 })]
    bond.mock.getOperativeEvents.mockResolvedValue(events)

    const result = withSetup(id)
    await nextTick()
    // Wait for the async loadEvents
    await new Promise(r => setTimeout(r, 0))

    expect(result.events.value).toHaveLength(2)
  })

  it('does not load events when operativeId is null', () => {
    const id = ref<string | null>(null)
    withSetup(id)
    expect(bond.mock.getOperativeEvents).not.toHaveBeenCalled()
  })

  it('appends events from operative.event notifications', async () => {
    const id = ref<string | null>('op1')
    const result = withSetup(id)
    await nextTick()
    await new Promise(r => setTimeout(r, 0))

    // Simulate an incoming event
    const newEvent = makeEvent({ id: 3, data: { text: 'new' } })
    for (const listener of bond.eventListeners) {
      listener({ operativeId: 'op1', event: newEvent })
    }

    expect(result.events.value).toContainEqual(expect.objectContaining({ id: 3 }))
  })

  it('ignores events for other operatives', async () => {
    const id = ref<string | null>('op1')
    const result = withSetup(id)
    await nextTick()
    await new Promise(r => setTimeout(r, 0))

    const otherEvent = makeEvent({ id: 99 })
    for (const listener of bond.eventListeners) {
      listener({ operativeId: 'op2', event: otherEvent })
    }

    expect(result.events.value).not.toContainEqual(expect.objectContaining({ id: 99 }))
  })

  it('clears events when operativeId becomes null', async () => {
    const id = ref<string | null>('op1')
    const events = [makeEvent({ id: 1 })]
    bond.mock.getOperativeEvents.mockResolvedValue(events)

    const result = withSetup(id)
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
    expect(result.events.value).toHaveLength(1)

    id.value = null
    await nextTick()
    expect(result.events.value).toHaveLength(0)
  })
})
