import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import {
  getSetting, setSetting,
  getSoul, saveSoul,
  getModelSetting, saveModelSetting,
  getAccentColor, saveAccentColor,
  getWindowOpacity, saveWindowOpacity,
  getSenseSettings, setSenseSettings,
  getRemotePort, getOrCreateRemoteToken,
  DEFAULT_REMOTE_PORT,
} from './settings'
import { DEFAULT_SENSE_SETTINGS } from '../shared/sense'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-settings-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('settings module', () => {
  describe('getSetting / setSetting', () => {
    it('returns null for missing key', () => {
      expect(getSetting('nonexistent')).toBeNull()
    })

    it('stores and retrieves a value', () => {
      setSetting('foo', 'bar')
      expect(getSetting('foo')).toBe('bar')
    })

    it('overwrites existing value', () => {
      setSetting('foo', 'bar')
      setSetting('foo', 'baz')
      expect(getSetting('foo')).toBe('baz')
    })

    it('returns true on success', () => {
      expect(setSetting('k', 'v')).toBe(true)
    })
  })

  describe('soul', () => {
    it('returns empty string by default', () => {
      expect(getSoul()).toBe('')
    })

    it('saves and retrieves soul', () => {
      saveSoul('You are helpful.')
      expect(getSoul()).toBe('You are helpful.')
    })
  })

  describe('model', () => {
    it('defaults to balanced', () => {
      expect(getModelSetting()).toBe('balanced')
    })

    it('saves and retrieves valid model', () => {
      saveModelSetting('high')
      expect(getModelSetting()).toBe('high')
    })

    it('saves fast tier', () => {
      saveModelSetting('fast')
      expect(getModelSetting()).toBe('fast')
    })

    it('migrates old provider labels and falls back to balanced', () => {
      setSetting('model', 'sonnet')
      expect(getModelSetting()).toBe('balanced')
      setSetting('model', 'gpt-4')
      expect(getModelSetting()).toBe('balanced')
    })
  })

  describe('accent color', () => {
    it('returns empty string by default', () => {
      expect(getAccentColor()).toBe('')
    })

    it('saves and retrieves color', () => {
      saveAccentColor('#ff0000')
      expect(getAccentColor()).toBe('#ff0000')
    })

    it('trims whitespace', () => {
      saveAccentColor('  #00ff00  ')
      expect(getAccentColor()).toBe('#00ff00')
    })
  })

  describe('window opacity', () => {
    it('defaults to 1', () => {
      expect(getWindowOpacity()).toBe(1)
    })

    it('saves and retrieves opacity', () => {
      saveWindowOpacity(0.5)
      expect(getWindowOpacity()).toBe(0.5)
    })

    it('clamps to 0-1 range', () => {
      saveWindowOpacity(1.5)
      expect(getWindowOpacity()).toBe(1)

      saveWindowOpacity(-0.5)
      expect(getWindowOpacity()).toBe(0)
    })

    it('returns 1 for invalid stored value', () => {
      setSetting('window_opacity', 'not-a-number')
      expect(getWindowOpacity()).toBe(1)
    })
  })

  describe('sense settings', () => {
    it('returns the defaults when nothing is stored', () => {
      expect(getSenseSettings()).toEqual(DEFAULT_SENSE_SETTINGS)
    })

    it('merges stored values over the defaults', () => {
      setSetting('sense', JSON.stringify({ enabled: true, retentionDays: 30 }))
      expect(getSenseSettings()).toEqual({ ...DEFAULT_SENSE_SETTINGS, enabled: true, retentionDays: 30 })
    })

    it('falls back to the defaults for a garbage row', () => {
      setSetting('sense', 'not-json{')
      expect(getSenseSettings()).toEqual(DEFAULT_SENSE_SETTINGS)
    })

    it('round-trips through setSenseSettings', () => {
      setSenseSettings({ ...DEFAULT_SENSE_SETTINGS, enabled: true, blacklistedApps: ['com.1password.1password'] })
      expect(getSenseSettings()).toEqual({ ...DEFAULT_SENSE_SETTINGS, enabled: true, blacklistedApps: ['com.1password.1password'] })
    })
  })

  describe('remote access', () => {
    it('defaults to the reserved port', () => {
      expect(getRemotePort()).toBe(DEFAULT_REMOTE_PORT)
    })

    it('honors a stored port override', () => {
      setSetting('remote.port', '4200')
      expect(getRemotePort()).toBe(4200)
    })

    it('falls back to the default for invalid ports', () => {
      setSetting('remote.port', 'not-a-port')
      expect(getRemotePort()).toBe(DEFAULT_REMOTE_PORT)
      setSetting('remote.port', '99999')
      expect(getRemotePort()).toBe(DEFAULT_REMOTE_PORT)
    })

    it('generates a pairing token once and keeps it stable', () => {
      const token = getOrCreateRemoteToken()
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      expect(getOrCreateRemoteToken()).toBe(token)
    })
  })
})
