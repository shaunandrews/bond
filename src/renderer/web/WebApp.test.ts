import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WebApp from './WebApp.vue'
import type { WebBondClient } from './client'

// The pairing screen is the whole point of these tests, so the chat side is
// stubbed out — useChat and the composer need a live daemon shim otherwise.
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    messages: { value: [] },
    busy: { value: false },
    pendingApprovals: { value: [] },
    currentQueue: { value: [] },
    contextUsage: { value: undefined },
    editMode: { value: { type: 'full' } },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    reconcileOnReconnect: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn(),
    cancel: vi.fn(),
    setEditMode: vi.fn(),
    respondToApproval: vi.fn(),
    removeQueuedMessage: vi.fn(),
  }),
}))

vi.mock('../composables/useAccentColor', () => ({
  useAccentColor: () => ({ load: vi.fn().mockResolvedValue(undefined) }),
}))

const mocks = vi.hoisted(() => ({
  isStandaloneDisplay: vi.fn(() => false),
  exchangePairingCode: vi.fn(),
  clearDeviceCredential: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  isStandaloneDisplay: mocks.isStandaloneDisplay,
  exchangePairingCode: mocks.exchangePairingCode,
  clearDeviceCredential: mocks.clearDeviceCredential,
}))

function fakeClient(state: WebBondClient['state'] = 'disconnected') {
  return {
    state,
    onStateChange: vi.fn().mockReturnValue(() => {}),
  } as unknown as WebBondClient
}

function mountApp(options: { standalone?: boolean; hasToken?: boolean; state?: WebBondClient['state'] } = {}) {
  const { standalone = false, hasToken = false, state = 'disconnected' } = options
  mocks.isStandaloneDisplay.mockReturnValue(standalone)
  return mount(WebApp, {
    props: { client: fakeClient(state), hasToken },
    global: { stubs: { MessageBubble: true, ChatInput: true, ApprovalPrompt: true } },
  })
}

beforeEach(() => {
  mocks.exchangePairingCode.mockReset()
  mocks.clearDeviceCredential.mockReset()
  mocks.isStandaloneDisplay.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WebApp pairing screen', () => {
  it('offers code entry when installed to the Home Screen and unpaired', () => {
    const wrapper = mountApp({ standalone: true })
    expect(wrapper.text()).toContain('Pair this device')
    expect(wrapper.find('input[aria-label="Pairing code"]').exists()).toBe(true)
  })

  it('keeps the QR instructions for an ordinary browser tab', () => {
    // The existing Safari flow must not be replaced — only supplemented.
    const wrapper = mountApp({ standalone: false })
    expect(wrapper.text()).toContain('scan the QR code')
    expect(wrapper.find('input[aria-label="Pairing code"]').exists()).toBe(false)
  })

  it('tells a browser user how to install to the Home Screen', () => {
    expect(mountApp({ standalone: false }).text()).toContain('Add to Home Screen')
  })

  it('shows the standalone pairing screen when a stored credential is rejected', () => {
    const wrapper = mountApp({ standalone: true, hasToken: true, state: 'unpaired' })
    expect(wrapper.text()).toContain('Pair this device')
  })

  it('says the app needs the Mac — never implies it works alone', () => {
    expect(mountApp({ standalone: true }).text()).toContain('Bond runs on your Mac')
  })

  it('protocol mismatch outranks pairing — a version skew is not a pairing problem', () => {
    const wrapper = mountApp({ standalone: true, state: 'mismatch' })
    expect(wrapper.text()).toContain('different protocol version')
    expect(wrapper.find('input[aria-label="Pairing code"]').exists()).toBe(false)
  })
})

describe('WebApp pairing submission', () => {
  async function submit(wrapper: ReturnType<typeof mountApp>, code: string) {
    await wrapper.find('input[aria-label="Pairing code"]').setValue(code)
    await wrapper.find('form').trigger('submit')
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('exchanges the entered code and reloads on success', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
      configurable: true,
    })
    mocks.exchangePairingCode.mockResolvedValue({ ok: true, deviceToken: 'x'.repeat(64) })

    await submit(mountApp({ standalone: true }), 'ABCD1234')

    expect(mocks.exchangePairingCode).toHaveBeenCalledWith('ABCD1234')
    expect(reload).toHaveBeenCalled()
  })

  it('trims what the user typed', async () => {
    mocks.exchangePairingCode.mockResolvedValue({ ok: false, reason: 'invalid' })
    await submit(mountApp({ standalone: true }), '  ABCD1234  ')
    expect(mocks.exchangePairingCode).toHaveBeenCalledWith('ABCD1234')
  })

  it.each([
    ['expired', 'expired'],
    ['used', 'already used'],
    ['invalid', "didn't match"],
    ['throttled', 'Too many attempts'],
    ['offline', 'same Wi-Fi'],
  ])('explains a %s result recoverably', async (reason, expected) => {
    mocks.exchangePairingCode.mockResolvedValue({ ok: false, reason })
    const wrapper = mountApp({ standalone: true })
    await submit(wrapper, 'ABCD1234')
    expect(wrapper.text()).toContain(expected)
    // Still on the pairing screen, still able to retry.
    expect(wrapper.find('input[aria-label="Pairing code"]').exists()).toBe(true)
  })

  it('does not submit an empty code', async () => {
    const wrapper = mountApp({ standalone: true })
    await wrapper.find('form').trigger('submit')
    expect(mocks.exchangePairingCode).not.toHaveBeenCalled()
  })

  it('drops a credential the daemon rejected so the next launch starts clean', async () => {
    mocks.exchangePairingCode.mockResolvedValue({ ok: false, reason: 'invalid' })
    await submit(mountApp({ standalone: true, hasToken: true, state: 'unpaired' }), 'ABCD1234')
    expect(mocks.clearDeviceCredential).toHaveBeenCalled()
  })

  it('keeps a never-paired client from clearing storage it never wrote', async () => {
    mocks.exchangePairingCode.mockResolvedValue({ ok: false, reason: 'expired' })
    await submit(mountApp({ standalone: true }), 'ABCD1234')
    expect(mocks.clearDeviceCredential).not.toHaveBeenCalled()
  })
})
