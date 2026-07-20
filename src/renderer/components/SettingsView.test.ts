import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsView from './SettingsView.vue'

describe('SettingsView', () => {
  beforeEach(() => {
    ;(window as any).bond = {
      getSoul: vi.fn().mockResolvedValue(''),
      getModel: vi.fn().mockResolvedValue('balanced'),
      listSkills: vi.fn().mockResolvedValue([]),
      getWindowOpacity: vi.fn().mockResolvedValue(1),
      senseStatus: vi.fn().mockResolvedValue({ enabled: false, state: 'disabled', storageBytes: 0, captureCount: 0 }),
      senseSettings: vi.fn().mockResolvedValue({ autoContextInChat: false, captureIntervalSeconds: 15 }),
      hasScreenRecordingPermission: vi.fn().mockResolvedValue(false),
      getPiStatus: vi.fn().mockResolvedValue({ configured: true, providers: [] }),
      mcpList: vi.fn().mockResolvedValue({ servers: [], presets: [] }),
      mcpStatus: vi.fn().mockResolvedValue({ servers: [] }),
      onMcpChanged: vi.fn(() => () => {}),
      remoteStatus: vi.fn().mockResolvedValue({ running: false, port: null, token: null, urls: [] }),
      createPairingCode: vi.fn().mockResolvedValue({ code: 'ABCD1234', expiresAt: Date.now() + 300_000 }),
      listRemoteDevices: vi.fn().mockResolvedValue({ devices: [] }),
      revokeRemoteDevice: vi.fn().mockResolvedValue({ ok: true }),
      revokeAllRemoteDevices: vi.fn().mockResolvedValue({ ok: true, revoked: 0 }),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The new-user simulation is triggered from the native application menu
  // (Bond → Run New-User Simulation), not from in-app Settings.
  it('does not surface the new-user simulation inside Settings', async () => {
    const wrapper = mount(SettingsView)
    await flushPromises()

    expect(wrapper.text()).not.toContain('Run new-user simulation')
    expect(wrapper.findAll('button').some(button => button.text() === 'Run new-user simulation')).toBe(false)
  })

  describe('Home Screen pairing', () => {
    function serving(devices: unknown[] = []) {
      ;(window as any).bond.remoteStatus.mockResolvedValue({
        running: true,
        port: 3113,
        token: 'tok',
        urls: ['http://192.168.1.5:3113/#t=tok'],
      })
      ;(window as any).bond.listRemoteDevices.mockResolvedValue({ devices })
    }

    function findButton(wrapper: ReturnType<typeof mount>, text: string) {
      return wrapper.findAll('button').find(b => b.text() === text)
    }

    it('hides pairing controls when the remote server is not serving', async () => {
      const wrapper = mount(SettingsView)
      await flushPromises()
      expect(findButton(wrapper, 'Generate pairing code')).toBeUndefined()
    })

    it('shows the generated code and a countdown', async () => {
      serving()
      const wrapper = mount(SettingsView)
      await flushPromises()

      await findButton(wrapper, 'Generate pairing code')!.trigger('click')
      await flushPromises()

      expect((window as any).bond.createPairingCode).toHaveBeenCalled()
      expect(wrapper.text()).toContain('ABCD1234')
      expect(wrapper.text()).toMatch(/expires in \d+:\d{2}/)
    })

    it('clears the code once it expires so a dead code is never left on screen', async () => {
      vi.useFakeTimers()
      serving()
      ;(window as any).bond.createPairingCode.mockResolvedValue({ code: 'ABCD1234', expiresAt: Date.now() + 2000 })
      const wrapper = mount(SettingsView)
      await flushPromises()

      await findButton(wrapper, 'Generate pairing code')!.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('ABCD1234')

      await vi.advanceTimersByTimeAsync(2500)
      expect(wrapper.text()).not.toContain('ABCD1234')
    })

    it('lists paired devices with a per-device revoke', async () => {
      serving([{ id: 'dev-1', label: '', createdAt: '2026-07-01T10:00:00.000Z', lastSeenAt: null }])
      const wrapper = mount(SettingsView)
      await flushPromises()

      expect(wrapper.text()).toContain('last seen never')
      await findButton(wrapper, 'Revoke')!.trigger('click')
      await flushPromises()

      expect((window as any).bond.revokeRemoteDevice).toHaveBeenCalledWith('dev-1')
      expect((window as any).bond.listRemoteDevices).toHaveBeenCalledTimes(2)
    })

    it('requires two clicks to revoke every device', async () => {
      serving([{ id: 'dev-1', label: '', createdAt: '2026-07-01T10:00:00.000Z', lastSeenAt: null }])
      const wrapper = mount(SettingsView)
      await flushPromises()

      await findButton(wrapper, 'Revoke all devices')!.trigger('click')
      await flushPromises()
      expect((window as any).bond.revokeAllRemoteDevices).not.toHaveBeenCalled()

      await findButton(wrapper, 'Click again to revoke all')!.trigger('click')
      await flushPromises()
      expect((window as any).bond.revokeAllRemoteDevices).toHaveBeenCalled()
    })

    it('survives a daemon that predates pairing support', async () => {
      serving()
      ;(window as any).bond.createPairingCode.mockRejectedValue(new Error('Unknown method'))
      ;(window as any).bond.listRemoteDevices.mockRejectedValue(new Error('Unknown method'))
      const wrapper = mount(SettingsView)
      await flushPromises()

      await findButton(wrapper, 'Generate pairing code')!.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('Remote access')
    })
  })
})
