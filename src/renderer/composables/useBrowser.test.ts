import { describe, it, expect, beforeEach } from 'vitest'
import { useBrowser } from './useBrowser'

describe('useBrowser', () => {
  let browser: ReturnType<typeof useBrowser>

  beforeEach(() => {
    localStorage.clear()
    browser = useBrowser()
    // Reset singleton state
    browser.closeAllTabs()
  })

  describe('createTab', () => {
    it('creates a tab and makes it active', () => {
      const id = browser.createTab('https://example.com')
      expect(browser.tabs.value).toHaveLength(1)
      expect(browser.activeTabId.value).toBe(id)
      expect(browser.tabs.value[0].url).toBe('https://example.com')
    })

    it('creates a blank tab', () => {
      const id = browser.createTab()
      expect(browser.tabs.value[0].url).toBe('about:blank')
      expect(browser.tabs.value[0].loading).toBe(false)
    })

    it('creates a hidden tab without activating it', () => {
      const visibleId = browser.createTab('https://a.com')
      const hiddenId = browser.createTab('https://b.com', { hidden: true })
      expect(browser.activeTabId.value).toBe(visibleId)
      expect(browser.hiddenTabs.value).toHaveLength(1)
    })
  })

  describe('closeTab', () => {
    it('removes the tab', () => {
      const id = browser.createTab('https://a.com')
      browser.closeTab(id)
      expect(browser.tabs.value).toHaveLength(0)
      expect(browser.activeTabId.value).toBeNull()
    })

    it('selects next tab when active tab is closed', () => {
      const id1 = browser.createTab('https://a.com')
      const id2 = browser.createTab('https://b.com')
      browser.closeTab(id2)
      expect(browser.activeTabId.value).toBe(id1)
    })
  })

  describe('closeAllTabs', () => {
    it('clears all tabs', () => {
      browser.createTab('https://a.com')
      browser.createTab('https://b.com')
      browser.closeAllTabs()
      expect(browser.tabs.value).toHaveLength(0)
      expect(browser.activeTabId.value).toBeNull()
    })
  })

  describe('switchTab', () => {
    it('switches active tab', () => {
      const id1 = browser.createTab('https://a.com')
      const id2 = browser.createTab('https://b.com')
      browser.switchTab(id1)
      expect(browser.activeTabId.value).toBe(id1)
    })

    it('does nothing for nonexistent tab', () => {
      const id = browser.createTab('https://a.com')
      browser.switchTab('fake')
      expect(browser.activeTabId.value).toBe(id)
    })
  })

  describe('navigate', () => {
    it('updates tab url and sets loading', () => {
      const id = browser.createTab('https://a.com')
      browser.navigate(id, 'https://b.com')
      expect(browser.tabs.value[0].url).toBe('https://b.com')
      expect(browser.tabs.value[0].loading).toBe(true)
    })
  })

  describe('updateTab', () => {
    it('updates tab properties', () => {
      const id = browser.createTab('https://a.com')
      browser.updateTab(id, { title: 'Example', loading: false })
      expect(browser.tabs.value[0].title).toBe('Example')
      expect(browser.tabs.value[0].loading).toBe(false)
    })
  })

  describe('promoteTab', () => {
    it('makes hidden tab visible and active', () => {
      browser.createTab('https://a.com')
      const hiddenId = browser.createTab('https://b.com', { hidden: true })
      browser.promoteTab(hiddenId)
      expect(browser.tabs.value.find(t => t.id === hiddenId)?.hidden).toBe(false)
      expect(browser.activeTabId.value).toBe(hiddenId)
    })
  })

  describe('favorites', () => {
    it('adds a favorite', () => {
      browser.addFavorite('https://a.com', 'A', null)
      expect(browser.favorites.value).toHaveLength(1)
      expect(browser.isFavorite('https://a.com')).toBe(true)
    })

    it('prevents duplicate favorites', () => {
      browser.addFavorite('https://a.com', 'A', null)
      browser.addFavorite('https://a.com', 'A again', null)
      expect(browser.favorites.value).toHaveLength(1)
    })

    it('removes a favorite', () => {
      browser.addFavorite('https://a.com', 'A', null)
      browser.removeFavorite('https://a.com')
      expect(browser.favorites.value).toHaveLength(0)
      expect(browser.isFavorite('https://a.com')).toBe(false)
    })
  })

  describe('console logs', () => {
    it('adds and retrieves console entries', () => {
      const id = browser.createTab('https://a.com')
      browser.addConsoleEntry(id, { level: 'log', text: 'hello', args: [], timestamp: Date.now() })
      const log = browser.getConsoleLog(id)
      expect(log).toHaveLength(1)
      expect(log[0].text).toBe('hello')
    })

    it('returns empty for unknown tab', () => {
      expect(browser.getConsoleLog('fake')).toEqual([])
    })
  })

  describe('network logs', () => {
    it('adds and retrieves network entries', () => {
      const id = browser.createTab('https://a.com')
      browser.addNetworkEntry(id, {
        requestId: 'r1', url: 'https://api.com', method: 'GET',
        status: 200, mimeType: 'application/json', size: 100, timing: 50,
        requestHeaders: {}, responseHeaders: {},
      })
      const log = browser.getNetworkLog(id)
      expect(log).toHaveLength(1)
      expect(log[0].url).toBe('https://api.com')
    })

    it('updates existing network entry', () => {
      const id = browser.createTab('https://a.com')
      browser.addNetworkEntry(id, {
        requestId: 'r1', url: 'https://api.com', method: 'GET',
        status: null, mimeType: null, size: null, timing: 0,
        requestHeaders: {}, responseHeaders: null,
      })
      browser.updateNetworkEntry(id, 'r1', { status: 200, size: 500 })
      const log = browser.getNetworkLog(id)
      expect(log[0].status).toBe(200)
      expect(log[0].size).toBe(500)
    })
  })

  describe('command handler', () => {
    it('returns error when no handler set', async () => {
      const result = await browser.handleCommand({ type: 'tabs', requestId: 'r1' })
      expect(result).toEqual({ error: 'No browser command handler registered' })
    })

    it('delegates to registered handler', async () => {
      browser.setCommandHandler(async (cmd) => ({ tabs: [] }))
      const result = await browser.handleCommand({ type: 'tabs', requestId: 'r1' })
      expect(result).toEqual({ tabs: [] })
    })
  })

  describe('computed', () => {
    it('activeTab returns current tab', () => {
      const id = browser.createTab('https://a.com')
      expect(browser.activeTab.value?.id).toBe(id)
    })

    it('visibleTabs excludes hidden', () => {
      browser.createTab('https://a.com')
      browser.createTab('https://b.com', { hidden: true })
      expect(browser.visibleTabs.value).toHaveLength(1)
    })

    it('hiddenTabs only includes hidden', () => {
      browser.createTab('https://a.com')
      browser.createTab('https://b.com', { hidden: true })
      expect(browser.hiddenTabs.value).toHaveLength(1)
    })
  })
})
