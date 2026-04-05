import { describe, it, expect } from 'vitest'
import { isBlacklisted, isAmbiguous } from './privacy'
import type { DetectedWindow } from '../../shared/sense'

function makeWindow(overrides: Partial<DetectedWindow> = {}): DetectedWindow {
  return {
    name: 'TestApp',
    bundleId: 'com.test.app',
    title: 'Test Window',
    active: false,
    pid: 1234,
    ...overrides,
  }
}

describe('privacy', () => {
  describe('isBlacklisted', () => {
    it('detects default blacklisted apps by bundle ID', () => {
      const windows = [makeWindow({ bundleId: 'com.1password.1password' })]
      expect(isBlacklisted(windows, [])).toBe(true)
    })

    it('detects user-blacklisted apps', () => {
      const windows = [makeWindow({ bundleId: 'com.custom.banking' })]
      expect(isBlacklisted(windows, ['com.custom.banking'])).toBe(true)
    })

    it('allows non-blacklisted apps', () => {
      const windows = [makeWindow({ bundleId: 'com.figma.Desktop' })]
      expect(isBlacklisted(windows, [])).toBe(false)
    })

    it('detects Safari private browsing by title', () => {
      const windows = [makeWindow({ title: 'Private Browsing — Safari' })]
      expect(isBlacklisted(windows, [])).toBe(true)
    })

    it('detects Chrome incognito by title', () => {
      const windows = [makeWindow({ title: 'New Tab — Incognito' })]
      expect(isBlacklisted(windows, [])).toBe(true)
    })

    it('detects Firefox private window by title', () => {
      const windows = [makeWindow({ title: 'Firefox Private Window' })]
      expect(isBlacklisted(windows, [])).toBe(true)
    })

    it('returns true if any visible window is blacklisted', () => {
      const windows = [
        makeWindow({ bundleId: 'com.figma.Desktop' }),
        makeWindow({ bundleId: 'com.1password.1password' }),
      ]
      expect(isBlacklisted(windows, [])).toBe(true)
    })
  })

  describe('isAmbiguous', () => {
    it('returns false when both snapshots show the same app', () => {
      const a = makeWindow({ bundleId: 'com.test.app', pid: 100 })
      const b = makeWindow({ bundleId: 'com.test.app', pid: 100 })
      expect(isAmbiguous(a, b)).toBe(false)
    })

    it('returns true when apps differ', () => {
      const a = makeWindow({ bundleId: 'com.app.one', pid: 100 })
      const b = makeWindow({ bundleId: 'com.app.two', pid: 200 })
      expect(isAmbiguous(a, b)).toBe(true)
    })

    it('returns true when PIDs differ for same bundle', () => {
      const a = makeWindow({ bundleId: 'com.test.app', pid: 100 })
      const b = makeWindow({ bundleId: 'com.test.app', pid: 200 })
      expect(isAmbiguous(a, b)).toBe(true)
    })

    it('returns false when either snapshot is null', () => {
      expect(isAmbiguous(null, makeWindow())).toBe(false)
      expect(isAmbiguous(makeWindow(), null)).toBe(false)
      expect(isAmbiguous(null, null)).toBe(false)
    })
  })
})
