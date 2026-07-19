import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildBondShim } from './shim'
import type { WebBondClient } from './client'

function mockClient() {
  return {
    call: vi.fn().mockResolvedValue({ ok: true }),
    subscribe: vi.fn().mockResolvedValue({ ok: true }),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onNotification: vi.fn().mockReturnValue(() => {}),
    onStateChange: vi.fn().mockReturnValue(() => {}),
  }
}

describe('buildBondShim', () => {
  let client: ReturnType<typeof mockClient>
  let bond: Window['bond']

  beforeEach(() => {
    client = mockClient()
    bond = buildBondShim(client as unknown as WebBondClient)
  })

  it('routes subscribe through WebBondClient so re-subscribe survives reconnects', async () => {
    await bond.subscribe()
    expect(client.subscribe).toHaveBeenCalledWith(undefined)
    expect(client.call).not.toHaveBeenCalledWith('bond.subscribe', expect.anything())

    await bond.subscribe('s1')
    expect(client.subscribe).toHaveBeenCalledWith('s1')
  })

  it('maps chat methods to the daemon RPC surface', async () => {
    await bond.send({ text: 'hi', turnId: 't', userMessageId: 'u', assistantMessageId: 'a', activityMessageId: 'act' })
    expect(client.call).toHaveBeenCalledWith('bond.send', expect.objectContaining({ text: 'hi', turnId: 't' }))

    await bond.respondToApproval('r1', true)
    expect(client.call).toHaveBeenCalledWith('bond.approvalResponse', { requestId: 'r1', approved: true })

    await bond.getImages(['a', 'b'])
    expect(client.call).toHaveBeenCalledWith('image.getMultiple', { ids: ['a', 'b'] })

    await bond.upsertTranscript([])
    expect(client.call).toHaveBeenCalledWith('transcript.upsert', { messages: [] })
  })

  it('supports the legacy positional send signature', async () => {
    await bond.send('hello', undefined, undefined)
    expect(client.call).toHaveBeenCalledWith('bond.send', { text: 'hello', sessionId: undefined, images: undefined })
  })

  it('emits local model-changed events after its own save, like the desktop main process does', async () => {
    const seen: string[] = []
    bond.onModelChanged(model => seen.push(model))
    await bond.setModel('high')
    expect(client.call).toHaveBeenCalledWith('bond.setModel', { model: 'high' })
    expect(seen).toEqual(['high'])
  })

  it('replaces openExternal with window.open and stubs filesystem access', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    await bond.openExternal('https://example.com')
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
    openSpy.mockRestore()

    await expect(bond.readLocalImage('/tmp/x.png')).resolves.toBeNull()
    await expect(bond.readFile('/tmp/x.md')).resolves.toBeNull()
  })

  it('wires entity-change events to daemon notifications', () => {
    const fn = vi.fn()
    bond.onImageChanged(fn)
    expect(client.onNotification).toHaveBeenCalledWith('image.changed', expect.any(Function))
    bond.onCollectionsChanged(fn)
    expect(client.onNotification).toHaveBeenCalledWith('collection.changed', expect.any(Function))
  })
})
