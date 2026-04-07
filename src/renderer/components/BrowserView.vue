<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useBrowser } from '../composables/useBrowser'
import type { BrowserTab, BrowserCommand, ConsoleEntry } from '../../shared/browser'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import BondToolbar from './BondToolbar.vue'
import BondPanelGroup from './BondPanelGroup.vue'
import BondPanel from './BondPanel.vue'
import BondPanelHandle from './BondPanelHandle.vue'
import BrowserDevTools from './BrowserDevTools.vue'
import {
  PhPlus, PhX, PhArrowLeft, PhArrowRight, PhArrowClockwise,
  PhStop, PhGlobe, PhArrowSquareOut, PhTerminal, PhStar,
  PhEyeSlash,
} from '@phosphor-icons/vue'

const emit = defineEmits<{
  openExternal: [url: string]
  ensureVisible: []
}>()

const browser = useBrowser()
const { tabs, activeTabId, favorites, visibleTabs, hiddenTabs } = browser
const hiddenTabsMenuOpen = ref(false)

const urlInput = ref('')
const urlInputRef = ref<HTMLInputElement | null>(null)
const emptyUrlInputRef = ref<HTMLInputElement | null>(null)
const urlFocused = ref(false)
const devtoolsOpen = ref(false)

// Map tabId → webview element ref
const webviewRefs = ref<Map<string, HTMLElement>>(new Map())
const boundWebviews = new Set<string>()
// Snapshot of initial URL per tab — prevents reactive :src from causing reload loops
const initialUrls = ref<Map<string, string>>(new Map())

const activeTab = computed(() => browser.activeTab.value)
const isNewTab = computed(() => activeTab.value?.url === 'about:blank')
const newTabInputRef = ref<HTMLInputElement | null>(null)

// Track initial URLs for new tabs (prevents reactive :src reload loops)
watch(tabs, (newTabs) => {
  for (const tab of newTabs) {
    if (!initialUrls.value.has(tab.id)) {
      initialUrls.value.set(tab.id, tab.url)
    }
  }
  // Clean up removed tabs
  for (const id of initialUrls.value.keys()) {
    if (!newTabs.some(t => t.id === id)) initialUrls.value.delete(id)
  }
}, { immediate: true, deep: true })

// Auto-focus new tab input
watch(isNewTab, (val) => {
  if (val) {
    urlInput.value = ''
    nextTick(() => newTabInputRef.value?.focus())
  }
})

// Sync URL input to active tab
watch(
  () => activeTab.value?.url,
  (url) => {
    if (!urlFocused.value && url) {
      urlInput.value = url === 'about:blank' ? '' : url
    }
  },
  { immediate: true }
)

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`
  // Treat as search query
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

// Navigate a tab by calling loadURL on the webview element directly
// (not via reactive :src which causes reload loops)
function navigateTab(tabId: string, url: string) {
  browser.navigate(tabId, url)
  const wv = getWebview(tabId)
  if (wv) (wv as any).loadURL(url)
}

function handleUrlSubmit() {
  const url = normalizeUrl(urlInput.value)
  if (browser.tabs.value.length === 0) {
    browser.createTab(url)
  } else if (activeTab.value) {
    navigateTab(activeTab.value.id, url)
  }
  urlInputRef.value?.blur()
}

function handleEmptyUrlSubmit() {
  const url = normalizeUrl(urlInput.value)
  browser.createTab(url)
}

function handleNewTabSubmit() {
  const url = normalizeUrl(urlInput.value)
  if (activeTab.value) {
    navigateTab(activeTab.value.id, url)
  }
}

function openFavoriteInTab(url: string) {
  if (activeTab.value && isNewTab.value) {
    navigateTab(activeTab.value.id, url)
  } else {
    browser.createTab(url)
  }
}

function handleNewTab() {
  browser.createTab()
  urlInput.value = ''
  nextTick(() => newTabInputRef.value?.focus())
}

function goBack() {
  const wv = getActiveWebview()
  if (wv && activeTab.value?.canGoBack) {
    ;(wv as any).goBack()
  }
}

function goForward() {
  const wv = getActiveWebview()
  if (wv && activeTab.value?.canGoForward) {
    ;(wv as any).goForward()
  }
}

function reload() {
  const wv = getActiveWebview()
  if (wv) {
    if (activeTab.value?.loading) {
      ;(wv as any).stop()
    } else {
      ;(wv as any).reload()
    }
  }
}

function toggleFavorite() {
  const tab = activeTab.value
  if (!tab || tab.url === 'about:blank') return
  if (browser.isFavorite(tab.url)) {
    browser.removeFavorite(tab.url)
  } else {
    browser.addFavorite(tab.url, tab.title, tab.favicon)
  }
}

const isCurrentFavorite = computed(() =>
  activeTab.value ? browser.isFavorite(activeTab.value.url) : false
)

function openFavorite(url: string) {
  browser.createTab(url)
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function openInSystemBrowser() {
  if (activeTab.value?.url && activeTab.value.url !== 'about:blank') {
    window.bond.openExternal(activeTab.value.url)
  }
}

function getActiveWebview(): HTMLElement | null {
  if (!browser.activeTabId.value) return null
  return webviewRefs.value.get(browser.activeTabId.value) ?? null
}

function resolveTabId(id: string): string {
  // Exact match first
  if (browser.tabs.value.some(t => t.id === id)) return id
  // Short prefix match
  const matches = browser.tabs.value.filter(t => t.id.startsWith(id))
  if (matches.length === 1) return matches[0].id
  return id // return as-is, getWebview will return null
}

function getWebview(tabId: string): HTMLElement | null {
  const resolved = resolveTabId(tabId)
  return webviewRefs.value.get(resolved) ?? null
}

function setWebviewRef(tabId: string, el: HTMLElement | null) {
  if (el) {
    webviewRefs.value.set(tabId, el)
  } else {
    webviewRefs.value.delete(tabId)
    boundWebviews.delete(tabId)
  }
}

function bindWebviewEvents(tabId: string, el: HTMLElement) {
  const wv = el as any

  wv.addEventListener('did-start-loading', () => {
    browser.updateTab(tabId, { loading: true })
  })

  wv.addEventListener('did-stop-loading', () => {
    browser.updateTab(tabId, { loading: false })
  })

  wv.addEventListener('page-title-updated', (e: any) => {
    browser.updateTab(tabId, { title: e.title })
  })

  wv.addEventListener('page-favicon-updated', (e: any) => {
    if (e.favicons?.length > 0) {
      browser.updateTab(tabId, { favicon: e.favicons[0] })
    }
  })

  wv.addEventListener('did-navigate', (e: any) => {
    const nav = wv.navigationHistory ?? wv
    browser.updateTab(tabId, {
      url: e.url,
      canGoBack: nav.canGoBack?.() ?? false,
      canGoForward: nav.canGoForward?.() ?? false,
      error: null,
    })
  })

  wv.addEventListener('did-navigate-in-page', (e: any) => {
    const nav = wv.navigationHistory ?? wv
    browser.updateTab(tabId, {
      url: e.url,
      canGoBack: nav.canGoBack?.() ?? false,
      canGoForward: nav.canGoForward?.() ?? false,
    })
  })

  wv.addEventListener('did-fail-load', (e: any) => {
    // Ignore aborted loads (user navigated away)
    if (e.errorCode === -3) return
    browser.updateTab(tabId, {
      loading: false,
      error: `${e.errorDescription || 'Failed to load'} (${e.errorCode})`,
    })
  })

  wv.addEventListener('new-window', (e: any) => {
    const url: string = e.url ?? ''
    // about:blank popups are often OAuth/auth flows that need window.opener — let them through
    if (!url || url === 'about:blank') return
    // Open link popups (target="_blank") in a new tab instead
    e.preventDefault()
    browser.createTab(url)
  })

  wv.addEventListener('console-message', (e: any) => {
    const levelMap: Record<number, ConsoleEntry['level']> = {
      0: 'debug', 1: 'log', 2: 'warn', 3: 'error',
    }
    browser.addConsoleEntry(tabId, {
      level: levelMap[e.level] ?? 'log',
      text: e.message,
      args: [e.message],
      timestamp: Date.now(),
      source: e.sourceId ? `${e.sourceId}:${e.line}` : undefined,
    })
  })

  // Register webContentsId with main process for CDP
  wv.addEventListener('dom-ready', () => {
    const wcId = wv.getWebContentsId?.()
    if (wcId != null && window.bond.browser) {
      window.bond.browser.registerWebContents(tabId, wcId)
    }
  })
}

// Handle commands from agent via IPC
function setupCommandListener() {
  if (!window.bond.browser) return null
  return window.bond.browser.onCommand(async (cmd: BrowserCommand) => {
    let result: unknown

    switch (cmd.type) {
      case 'open': {
        const hidden = cmd.hidden ?? false
        const tabId = browser.createTab(cmd.url, { hidden })
        if (!hidden) emit('ensureVisible')
        // Wait for load
        await waitForLoad(tabId, 10000)
        const tab = browser.tabs.value.find(t => t.id === tabId)
        result = { tabId, title: tab?.title ?? '', url: tab?.url ?? cmd.url, hidden }
        break
      }
      case 'navigate': {
        navigateTab(cmd.tabId, cmd.url)
        await waitForLoad(cmd.tabId, 10000)
        const tab = browser.tabs.value.find(t => t.id === cmd.tabId)
        result = { title: tab?.title ?? '', url: tab?.url ?? cmd.url }
        break
      }
      case 'close': {
        browser.closeTab(cmd.tabId)
        result = { ok: true }
        break
      }
      case 'tabs': {
        result = browser.tabs.value.map(t => ({
          id: t.id, url: t.url, title: t.title, loading: t.loading,
          active: t.id === browser.activeTabId.value,
          hidden: t.hidden,
        }))
        break
      }
      case 'read': {
        const wv = getWebview(cmd.tabId ?? browser.activeTabId.value ?? '')
        if (wv) {
          result = await (wv as any).executeJavaScript('document.body.innerText')
        } else {
          result = { error: 'No active tab' }
        }
        break
      }
      case 'screenshot': {
        const wv = getWebview(cmd.tabId ?? browser.activeTabId.value ?? '')
        if (wv) {
          // capturePage returns NativeImage, we need the main process to handle this
          result = await window.bond.browser.captureTab(cmd.tabId ?? browser.activeTabId.value ?? '')
        } else {
          result = { error: 'No active tab' }
        }
        break
      }
      case 'exec': {
        const wv = getWebview(cmd.tabId ?? browser.activeTabId.value ?? '')
        if (wv) {
          try {
            const val = await (wv as any).executeJavaScript(cmd.js)
            result = { value: typeof val === 'object' ? JSON.stringify(val) : String(val) }
          } catch (e: any) {
            result = { error: e.message }
          }
        } else {
          result = { error: 'No active tab' }
        }
        break
      }
      case 'console': {
        result = browser.getConsoleLog(cmd.tabId)
        break
      }
      case 'dom': {
        const wv = getWebview(cmd.tabId ?? browser.activeTabId.value ?? '')
        if (wv) {
          const selector = cmd.selector
          const js = selector
            ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null })()`
            : `document.documentElement.outerHTML.slice(0, 50000)`
          try {
            result = await (wv as any).executeJavaScript(js)
          } catch (e: any) {
            result = { error: e.message }
          }
        } else {
          result = { error: 'No active tab' }
        }
        break
      }
      case 'network': {
        result = browser.getNetworkLog(cmd.tabId)
        break
      }
      case 'download': {
        const wv = getWebview(cmd.tabId ?? browser.activeTabId.value ?? '')
        if (wv) {
          try {
            // Use the webview's session to fetch the URL (inherits cookies/auth)
            const js = `
              (async () => {
                const r = await fetch(${JSON.stringify(cmd.url)}, { credentials: 'same-origin' });
                if (!r.ok) return { error: 'HTTP ' + r.status + ' ' + r.statusText };
                const contentType = r.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
                const buf = await r.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const chunks = [];
                for (let i = 0; i < bytes.length; i += 8192) {
                  chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
                }
                const b64 = btoa(chunks.join(''));
                return { data: b64, contentType, size: buf.byteLength };
              })()
            `
            const dlResult = await (wv as any).executeJavaScript(js)
            if (dlResult?.error) {
              result = dlResult
            } else if (dlResult?.data) {
              // Send base64 data back — the daemon will handle file writing
              result = {
                data: dlResult.data,
                contentType: dlResult.contentType,
                size: dlResult.size,
                outPath: cmd.outPath,
              }
            }
          } catch (e: any) {
            result = { error: e.message }
          }
        } else {
          result = { error: 'No active tab' }
        }
        break
      }
      case 'cookies': {
        const wv = getWebview(cmd.tabId ?? browser.activeTabId.value ?? '')
        if (wv) {
          try {
            const js = `document.cookie`
            const cookies = await (wv as any).executeJavaScript(js)
            // Also get the current URL for context
            const url = await (wv as any).executeJavaScript('window.location.href')
            result = { cookies, url }
          } catch (e: any) {
            result = { error: e.message }
          }
        } else {
          result = { error: 'No active tab' }
        }
        break
      }
    }

    if (window.bond.browser) {
      window.bond.browser.commandResult(cmd.requestId, result)
    }
  })
}

function waitForLoad(tabId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      const tab = browser.tabs.value.find(t => t.id === tabId)
      if (!tab || !tab.loading || Date.now() - start > timeoutMs) {
        resolve()
      } else {
        setTimeout(check, 100)
      }
    }
    // Give the webview a moment to start loading
    setTimeout(check, 200)
  })
}

let removeCommandListener: (() => void) | null = null

onMounted(() => {
  removeCommandListener = setupCommandListener()
})

onUnmounted(() => {
  removeCommandListener?.()
  // Unregister all webContentsIds
  if (window.bond.browser) {
    for (const tabId of webviewRefs.value.keys()) {
      window.bond.browser.unregisterWebContents(tabId)
    }
  }
})

// Public method for external navigation (e.g., from MarkdownMessage links)
function openUrl(url: string) {
  if (browser.tabs.value.length === 0) {
    browser.createTab(url)
  } else if (activeTab.value) {
    navigateTab(activeTab.value.id, url)
  } else {
    browser.createTab(url)
  }
}

function focusUrlBar() {
  urlInputRef.value?.focus()
  urlInputRef.value?.select()
}

defineExpose({ openUrl, focusUrlBar })
</script>

<template>
  <!-- Hidden tab webviews — always rendered so they stay alive -->
  <template v-for="tab in hiddenTabs" :key="'hidden-' + tab.id">
    <webview
      :ref="(el: any) => { if (el?.$el || el) { const node = el.$el || el; setWebviewRef(tab.id, node); if (!boundWebviews.has(tab.id)) { boundWebviews.add(tab.id); bindWebviewEvents(tab.id, node) } } }"
      :src="initialUrls.get(tab.id) ?? 'about:blank'"
      partition="persist:browser"
      allowpopups
      class="browser-webview browser-webview--hidden"
    />
  </template>

  <!-- Empty state — no visible tabs open -->
  <div v-if="visibleTabs.length === 0" class="browser-empty">
    <!-- Hidden tabs button in empty state -->
    <div v-if="hiddenTabs.length > 0" class="browser-empty-hidden-tabs">
      <div class="browser-hidden-tabs-wrap">
        <button
          class="browser-tab-new"
          @click="hiddenTabsMenuOpen = !hiddenTabsMenuOpen"
          v-tooltip="'Background tabs'"
        >
          <PhEyeSlash :size="12" />
          <span class="browser-hidden-badge">{{ hiddenTabs.length }}</span>
        </button>
        <div v-if="hiddenTabsMenuOpen" class="browser-hidden-menu" @mouseleave="hiddenTabsMenuOpen = false">
          <div class="browser-hidden-menu-header">Background tabs</div>
          <div
            v-for="tab in hiddenTabs"
            :key="tab.id"
            class="browser-hidden-menu-item"
            @click="browser.promoteTab(tab.id); hiddenTabsMenuOpen = false; emit('ensureVisible')"
          >
            <img v-if="tab.favicon" :src="tab.favicon" class="browser-tab-favicon" />
            <PhGlobe v-else :size="12" class="browser-tab-favicon-placeholder" />
            <span class="browser-hidden-menu-title">{{ tab.title || getDomain(tab.url) }}</span>
            <span class="browser-hidden-menu-url">{{ getDomain(tab.url) }}</span>
            <button class="browser-tab-close browser-hidden-menu-close" @click.stop="browser.closeTab(tab.id)">
              <PhX :size="10" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="browser-empty-inner">
      <form class="browser-empty-form" @submit.prevent="handleEmptyUrlSubmit">
        <input
          ref="emptyUrlInputRef"
          v-model="urlInput"
          type="text"
          class="browser-url-input browser-url-input--empty"
          placeholder="Enter a URL or search..."
          spellcheck="false"
          autocomplete="off"
        />
      </form>

      <!-- Favorites grid -->
      <div v-if="favorites.length > 0" class="browser-favorites">
        <div
          v-for="fav in favorites"
          :key="fav.url"
          class="browser-favorite"
          @click="openFavorite(fav.url)"
        >
          <div class="browser-favorite-icon">
            <img v-if="fav.favicon" :src="fav.favicon" width="16" height="16" />
            <PhGlobe v-else :size="16" weight="regular" />
          </div>
          <span class="browser-favorite-label">{{ fav.title || getDomain(fav.url) }}</span>
        </div>
      </div>
      <BondText v-else size="xs" color="muted" class="browser-empty-hint">Star pages to add favorites</BondText>
    </div>
  </div>

  <!-- Browser with tabs -->
  <div v-else class="browser-wrap">
    <!-- Tab bar -->
    <div class="browser-tab-bar">
      <div class="browser-tabs-scroll">
        <div
          v-for="tab in visibleTabs"
          :key="tab.id"
          :class="['browser-tab', { 'browser-tab--active': tab.id === activeTabId }]"
          @click="browser.switchTab(tab.id)"
          @mousedown.middle.prevent="browser.closeTab(tab.id)"
        >
          <img v-if="tab.favicon" :src="tab.favicon" class="browser-tab-favicon" />
          <PhGlobe v-else :size="12" class="browser-tab-favicon-placeholder" />
          <span class="browser-tab-title">{{ tab.title }}</span>
          <button class="browser-tab-close" @click.stop="browser.closeTab(tab.id)" v-tooltip="'Close tab'">
            <PhX :size="10" />
          </button>
        </div>
      </div>

      <!-- Hidden tabs menu -->
      <div v-if="hiddenTabs.length > 0" class="browser-hidden-tabs-wrap">
        <button
          class="browser-tab-new"
          @click="hiddenTabsMenuOpen = !hiddenTabsMenuOpen"
          v-tooltip="'Background tabs'"
        >
          <PhEyeSlash :size="12" />
          <span class="browser-hidden-badge">{{ hiddenTabs.length }}</span>
        </button>
        <div v-if="hiddenTabsMenuOpen" class="browser-hidden-menu" @mouseleave="hiddenTabsMenuOpen = false">
          <div class="browser-hidden-menu-header">Background tabs</div>
          <div
            v-for="tab in hiddenTabs"
            :key="tab.id"
            class="browser-hidden-menu-item"
            @click="browser.promoteTab(tab.id); hiddenTabsMenuOpen = false"
          >
            <img v-if="tab.favicon" :src="tab.favicon" class="browser-tab-favicon" />
            <PhGlobe v-else :size="12" class="browser-tab-favicon-placeholder" />
            <span class="browser-hidden-menu-title">{{ tab.title || getDomain(tab.url) }}</span>
            <span class="browser-hidden-menu-url">{{ getDomain(tab.url) }}</span>
            <button class="browser-tab-close browser-hidden-menu-close" @click.stop="browser.closeTab(tab.id)">
              <PhX :size="10" />
            </button>
          </div>
        </div>
      </div>

      <button class="browser-tab-new" @click="handleNewTab" v-tooltip="'New tab'">
        <PhPlus :size="12" />
      </button>
    </div>

    <!-- Nav bar -->
    <div class="browser-nav">
      <BondButton variant="ghost" size="sm" icon :disabled="!activeTab?.canGoBack" @click="goBack" v-tooltip="'Back'">
        <PhArrowLeft :size="14" />
      </BondButton>
      <BondButton variant="ghost" size="sm" icon :disabled="!activeTab?.canGoForward" @click="goForward" v-tooltip="'Forward'">
        <PhArrowRight :size="14" />
      </BondButton>
      <BondButton variant="ghost" size="sm" icon @click="reload" v-tooltip="activeTab?.loading ? 'Stop' : 'Reload'">
        <PhStop v-if="activeTab?.loading" :size="14" />
        <PhArrowClockwise v-else :size="14" />
      </BondButton>

      <form class="browser-nav-url" @submit.prevent="handleUrlSubmit">
        <input
          ref="urlInputRef"
          v-model="urlInput"
          type="text"
          class="browser-url-input"
          placeholder="URL or search..."
          spellcheck="false"
          autocomplete="off"
          @focus="urlFocused = true; ($event.target as HTMLInputElement)?.select()"
          @blur="urlFocused = false"
        />
        <div v-if="activeTab?.loading" class="browser-loading-bar" />
      </form>

      <BondButton variant="ghost" size="sm" icon :class="{ 'browser-star--active': isCurrentFavorite }" @click="toggleFavorite" v-tooltip="isCurrentFavorite ? 'Remove favorite' : 'Add to favorites'">
        <PhStar :size="14" :weight="isCurrentFavorite ? 'fill' : 'regular'" />
      </BondButton>
      <BondButton variant="ghost" size="sm" icon @click="openInSystemBrowser" v-tooltip="'Open in system browser'">
        <PhArrowSquareOut :size="14" />
      </BondButton>
      <BondButton variant="ghost" size="sm" icon :class="{ 'panel-toggle-active': devtoolsOpen }" @click="devtoolsOpen = !devtoolsOpen" v-tooltip="'Toggle DevTools'">
        <PhTerminal :size="14" />
      </BondButton>
    </div>

    <!-- Content area: webview + devtools in vertical split -->
    <BondPanelGroup direction="vertical" class="browser-content">
      <BondPanel id="browser-webview" :defaultSize="70" :minSize="20">
        <div class="browser-webview-area">
          <!-- New tab overlay with favorites -->
          <div v-if="isNewTab" class="browser-newtab">
            <div class="browser-empty-inner">
              <form class="browser-empty-form" @submit.prevent="handleNewTabSubmit">
                <input
                  ref="newTabInputRef"
                  v-model="urlInput"
                  type="text"
                  class="browser-url-input browser-url-input--empty"
                  placeholder="Enter a URL or search..."
                  spellcheck="false"
                  autocomplete="off"
                />
              </form>

              <div v-if="favorites.length > 0" class="browser-favorites">
                <div
                  v-for="fav in favorites"
                  :key="fav.url"
                  class="browser-favorite"
                  @click="openFavoriteInTab(fav.url)"
                >
                  <div class="browser-favorite-icon">
                    <img v-if="fav.favicon" :src="fav.favicon" width="16" height="16" />
                    <PhGlobe v-else :size="16" weight="regular" />
                  </div>
                  <span class="browser-favorite-label">{{ fav.title || getDomain(fav.url) }}</span>
                </div>
              </div>
              <BondText v-else size="xs" color="muted" class="browser-empty-hint">Star pages to add favorites</BondText>
            </div>
          </div>

          <!-- Error overlay -->
          <div v-if="activeTab?.error" class="browser-error">
            <BondText size="sm" color="err">{{ activeTab.error }}</BondText>
          </div>

          <!-- One webview per visible tab, hidden with width:0/height:0 for inactive -->
          <template v-for="tab in visibleTabs" :key="tab.id">
            <webview
              :ref="(el: any) => { if (el?.$el || el) { const node = el.$el || el; setWebviewRef(tab.id, node); if (!boundWebviews.has(tab.id)) { boundWebviews.add(tab.id); bindWebviewEvents(tab.id, node) } } }"
              :src="initialUrls.get(tab.id) ?? 'about:blank'"
              partition="persist:browser"
              allowpopups
              :class="['browser-webview', { 'browser-webview--hidden': tab.id !== activeTabId }]"
            />
          </template>
        </div>
      </BondPanel>

      <BondPanelHandle v-show="devtoolsOpen" id="handle-devtools" />

      <BondPanel v-show="devtoolsOpen" id="browser-devtools" :defaultSize="30" :minSize="15">
        <BrowserDevTools />
      </BondPanel>
    </BondPanelGroup>
  </div>
</template>

<style>
.browser-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 2rem;
  border-left: 1px solid var(--color-border);
}

.browser-empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  width: 100%;
  max-width: 420px;
}

.browser-empty-hint {
  opacity: 0.5;
}

/* Favorites grid */
.browser-favorites {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: 8px;
  width: 100%;
}

.browser-favorite {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 6px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.browser-favorite:hover {
  background: var(--color-tint);
}

.browser-favorite-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-muted);
}

.browser-favorite-icon img {
  border-radius: 2px;
}

.browser-favorite-label {
  font-size: 10px;
  color: var(--color-muted);
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* New tab overlay */
.browser-newtab {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg);
  padding: 2rem;
}

/* Star button active state */
.browser-star--active {
  color: #e6a23c !important;
}

.browser-empty-form {
  width: 100%;
}

.browser-url-input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: var(--font-sans);
  outline: none;
  transition: border-color var(--transition-fast);
}

.browser-url-input:focus {
  border-color: var(--color-accent);
}

.browser-url-input--empty {
  height: 36px;
  font-size: 13px;
  text-align: center;
  border-radius: var(--radius-lg);
}

.browser-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
}

/* Tab bar */
.browser-tab-bar {
  display: flex;
  align-items: center;
  padding: 6px 6px 2px;
  flex-shrink: 0;
  gap: 2px;
}

.browser-tabs-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  gap: 4px;
  scrollbar-width: none;
}
.browser-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.browser-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 30px;
  min-width: 0;
  max-width: 180px;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--color-muted);
  font-size: 12px;
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.browser-tab:hover {
  background: var(--color-tint);
  color: var(--color-text-primary);
}

.browser-tab--active {
  background: var(--color-tint);
  color: var(--color-text-primary);
}

.browser-tab-favicon {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
}

.browser-tab-favicon-placeholder {
  flex-shrink: 0;
  opacity: 0.5;
}

.browser-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.browser-tab-close {
  all: unset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  cursor: pointer;
  color: var(--color-muted);
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}

.browser-tab:hover .browser-tab-close {
  opacity: 1;
}

.browser-tab-close:hover {
  background: var(--color-tint);
  color: var(--color-text-primary);
}

.browser-tab-new {
  all: unset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--color-muted);
  flex-shrink: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.browser-tab-new:hover {
  background: var(--color-tint);
  color: var(--color-text-primary);
}

/* Nav bar */
.browser-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px 6px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.browser-nav-url {
  flex: 1;
  min-width: 0;
  position: relative;
}

.browser-loading-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: var(--color-accent);
  border-radius: 1px;
  animation: browser-loading 1.5s ease-in-out infinite;
}

@keyframes browser-loading {
  0% { width: 0; left: 0; }
  50% { width: 60%; left: 20%; }
  100% { width: 0; left: 100%; }
}

/* Content / webview area */
.browser-content {
  flex: 1;
  min-height: 0;
}

.browser-webview-area {
  position: relative;
  height: 100%;
}

.browser-webview {
  width: 100%;
  height: 100%;
}

.browser-webview--hidden {
  width: 0;
  height: 0;
  overflow: hidden;
  flex-shrink: 0;
  position: absolute;
}

.browser-error {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--color-err) 10%, var(--color-surface));
  border-bottom: 1px solid color-mix(in srgb, var(--color-err) 30%, transparent);
  z-index: 1;
}

/* Hidden tabs */
.browser-hidden-tabs-wrap {
  position: relative;
  flex-shrink: 0;
}

.browser-hidden-badge {
  font-size: 9px;
  font-weight: 600;
  min-width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-accent);
  color: #fff;
  border-radius: 7px;
  position: absolute;
  top: -2px;
  right: -4px;
  padding: 0 3px;
  pointer-events: none;
}

.browser-hidden-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 260px;
  max-width: 340px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  z-index: 100;
  overflow: hidden;
}

.browser-hidden-menu-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-muted);
  padding: 8px 12px 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.browser-hidden-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.browser-hidden-menu-item:hover {
  background: var(--color-tint);
}

.browser-hidden-menu-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-primary);
}

.browser-hidden-menu-url {
  font-size: 11px;
  color: var(--color-muted);
  flex-shrink: 0;
}

.browser-hidden-menu-close {
  opacity: 0;
}

.browser-hidden-menu-item:hover .browser-hidden-menu-close {
  opacity: 1;
}

/* Hidden tabs button in empty state */
.browser-empty-hidden-tabs {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
}

.browser-empty {
  position: relative;
}
</style>
