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
} from './settings'

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
    it('defaults to sonnet', () => {
      expect(getModelSetting()).toBe('sonnet')
    })

    it('saves and retrieves valid model', () => {
      saveModelSetting('opus')
      expect(getModelSetting()).toBe('opus')
    })

    it('saves haiku', () => {
      saveModelSetting('haiku')
      expect(getModelSetting()).toBe('haiku')
    })

    it('falls back to sonnet for invalid model', () => {
      setSetting('model', 'gpt-4')
      expect(getModelSetting()).toBe('sonnet')
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
})
