import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    }
  })

  // The new-user simulation is triggered from the native application menu
  // (Bond → Run New-User Simulation), not from in-app Settings.
  it('does not surface the new-user simulation inside Settings', async () => {
    const wrapper = mount(SettingsView)
    await flushPromises()

    expect(wrapper.text()).not.toContain('Run new-user simulation')
    expect(wrapper.findAll('button').some(button => button.text() === 'Run new-user simulation')).toBe(false)
  })
})
