import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_NOT_RUNNING_ERROR, onRenderReady, pendingRenderCount, renderPage, setRenderTransport } from './broker'
import type { WebRenderRequest } from '../../shared/web'

afterEach(() => {
  setRenderTransport(null)
  vi.useRealTimers()
})

describe('renderPage', () => {
  it('rejects immediately when no app transport is installed', async () => {
    await expect(renderPage('https://example.com')).rejects.toThrow(APP_NOT_RUNNING_ERROR)
    expect(pendingRenderCount()).toBe(0)
  })

  it('rejects when the transport delivers to no clients', async () => {
    setRenderTransport(() => false)
    await expect(renderPage('https://example.com')).rejects.toThrow(APP_NOT_RUNNING_ERROR)
    expect(pendingRenderCount()).toBe(0)
  })

  it('rejects when the transport itself throws', async () => {
    setRenderTransport(() => { throw new Error('socket gone') })
    await expect(renderPage('https://example.com')).rejects.toThrow(APP_NOT_RUNNING_ERROR)
    expect(pendingRenderCount()).toBe(0)
  })

  it('resolves with the rendered page when the app replies', async () => {
    let sent: WebRenderRequest | undefined
    setRenderTransport((request) => { sent = request; return true })

    const promise = renderPage('https://example.com', { waitForSelector: '.result' })
    expect(sent).toBeDefined()
    expect(sent!.url).toBe('https://example.com')
    expect(sent!.waitForSelector).toBe('.result')
    expect(pendingRenderCount()).toBe(1)

    onRenderReady({ renderId: sent!.renderId, ok: true, html: '<html></html>', finalUrl: 'https://example.com/', title: 'Example' })
    await expect(promise).resolves.toEqual({ html: '<html></html>', finalUrl: 'https://example.com/', title: 'Example' })
    expect(pendingRenderCount()).toBe(0)
  })

  it('rejects with the app-reported error on a failed render', async () => {
    let sent: WebRenderRequest | undefined
    setRenderTransport((request) => { sent = request; return true })

    const promise = renderPage('https://example.com')
    onRenderReady({ renderId: sent!.renderId, ok: false, error: 'net::ERR_NAME_NOT_RESOLVED' })
    await expect(promise).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED')
  })

  it('times out when the app never replies', async () => {
    vi.useFakeTimers()
    setRenderTransport(() => true)

    const promise = renderPage('https://example.com', { timeoutMs: 1000 })
    const assertion = expect(promise).rejects.toThrow(/Timed out .* https:\/\/example\.com/)
    // Broker timeout = render budget + reply margin (5s).
    vi.advanceTimersByTime(6001)
    await assertion
    expect(pendingRenderCount()).toBe(0)
  })
})

describe('onRenderReady', () => {
  it('ignores results for unknown or already-settled renders', () => {
    expect(onRenderReady({ renderId: 'nope', ok: true, html: '' })).toBe(false)
  })
})
