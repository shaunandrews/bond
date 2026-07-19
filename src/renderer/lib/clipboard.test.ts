import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyToClipboard } from './clipboard'

// Regression precedent: useChat's uid() fallback for the insecure-context LAN
// web client (useChat.test.ts "submits without crypto.randomUUID"). Clipboard
// has the same constraint — navigator.clipboard is undefined over plain http.

const originalClipboard = navigator.clipboard

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

beforeEach(() => {
  document.execCommand = vi.fn().mockReturnValue(true)
})

afterEach(() => {
  setClipboard(originalClipboard)
})

describe('copyToClipboard', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })

    expect(await copyToClipboard('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(document.execCommand).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back to execCommand when navigator.clipboard is undefined (insecure context)', async () => {
    setClipboard(undefined)

    expect(await copyToClipboard('lan copy')).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    // The scratch textarea is cleaned up.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back to execCommand when writeText rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })

    expect(await copyToClipboard('fallback')).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })

  it('reports failure when no mechanism works', async () => {
    setClipboard(undefined)
    document.execCommand = vi.fn(() => { throw new Error('unsupported') })

    expect(await copyToClipboard('nope')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
