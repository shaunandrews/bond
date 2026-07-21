import { describe, it, expect, beforeEach, vi } from 'vitest'
import { closeDesk, isDeskOpen, openDesk, registerDeskWindowHost, type DeskWindowHost } from './desk'

beforeEach(() => {
  registerDeskWindowHost(null)
})

function host(over: Partial<DeskWindowHost> = {}): DeskWindowHost {
  return {
    open: async () => ({ opened: true }),
    close: () => {},
    isOpen: () => true,
    ...over,
  }
}

describe('openDesk without a registered host', () => {
  it('reports unavailable rather than claiming a window it never created', async () => {
    expect(await openDesk()).toEqual({ opened: false, reason: 'unavailable' })
    expect(isDeskOpen()).toBe(false)
  })

  it('closing is a safe no-op', () => {
    expect(() => closeDesk()).not.toThrow()
  })
})

describe('openDesk with a host', () => {
  it('delegates and passes the queued flag through', async () => {
    const open = vi.fn(async () => ({ opened: true }))
    registerDeskWindowHost(host({ open }))

    expect(await openDesk({ queued: true })).toEqual({ opened: true })
    expect(open).toHaveBeenCalledWith({ queued: true })
  })

  it('a throwing host degrades to a reason instead of rejecting', async () => {
    registerDeskWindowHost(host({ open: async () => { throw new Error('NSPanel refused') } }))
    expect(await openDesk()).toEqual({ opened: false, reason: 'NSPanel refused' })
  })

  it('a non-Error throw still produces a reason', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerDeskWindowHost(host({ open: async () => { throw 'nope' } }))
    expect(await openDesk()).toEqual({ opened: false, reason: 'open_failed' })
  })

  it('reports open state and forwards close', () => {
    const close = vi.fn()
    registerDeskWindowHost(host({ close, isOpen: () => true }))
    expect(isDeskOpen()).toBe(true)
    closeDesk()
    expect(close).toHaveBeenCalled()
  })

  it('unregistering returns to the unavailable state', async () => {
    registerDeskWindowHost(host())
    registerDeskWindowHost(null)
    expect(await openDesk()).toMatchObject({ opened: false })
  })
})
