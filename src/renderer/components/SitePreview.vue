<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { PhArrowLeft, PhArrowRight, PhArrowClockwise, PhX } from '@phosphor-icons/vue'
import { useSitePreview } from '../composables/useSitePreview'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'

const { url, loading, canGoBack, canGoForward, close } = useSitePreview()

const webviewRef = ref<HTMLElement | null>(null)
const ready = ref(false)

function getWebview(): Electron.WebviewTag | null {
  return webviewRef.value as unknown as Electron.WebviewTag | null
}

function goBack() {
  if (ready.value) getWebview()?.goBack()
}

function goForward() {
  if (ready.value) getWebview()?.goForward()
}

function reload() {
  if (ready.value) getWebview()?.reload()
}

function updateNavState() {
  const wv = getWebview()
  if (!wv || !ready.value) return
  canGoBack.value = wv.canGoBack()
  canGoForward.value = wv.canGoForward()
}

function handleDidNavigate(e: { url: string }) {
  url.value = e.url
  updateNavState()
}

function handleDidNavigateInPage(e: { url: string; isMainFrame: boolean }) {
  if (e.isMainFrame) {
    url.value = e.url
    updateNavState()
  }
}

function handleStartLoading() {
  loading.value = true
}

function handleStopLoading() {
  loading.value = false
  updateNavState()
}

function handleNewWindow(e: { url: string; disposition: string }) {
  if (e.url && (e.url.startsWith('http://') || e.url.startsWith('https://'))) {
    window.bond.openExternal(e.url)
  }
}

function attachListeners() {
  const wv = getWebview()
  if (!wv) return

  wv.addEventListener('did-navigate', handleDidNavigate as EventListener)
  wv.addEventListener('did-navigate-in-page', handleDidNavigateInPage as EventListener)
  wv.addEventListener('did-start-loading', handleStartLoading)
  wv.addEventListener('did-stop-loading', handleStopLoading)
  wv.addEventListener('new-window', handleNewWindow as EventListener)
}

function detachListeners() {
  const wv = getWebview()
  if (!wv) return

  wv.removeEventListener('did-navigate', handleDidNavigate as EventListener)
  wv.removeEventListener('did-navigate-in-page', handleDidNavigateInPage as EventListener)
  wv.removeEventListener('did-start-loading', handleStartLoading)
  wv.removeEventListener('did-stop-loading', handleStopLoading)
  wv.removeEventListener('new-window', handleNewWindow as EventListener)
}

// When URL changes externally (e.g. switching sites), navigate the webview
watch(url, (newUrl) => {
  if (!ready.value || !newUrl) return
  const wv = getWebview()
  if (wv && wv.getURL() !== newUrl) {
    wv.loadURL(newUrl)
  }
})

// Attach listeners whenever the webview mounts (v-if toggles it)
watch(webviewRef, (el) => {
  if (!el) {
    ready.value = false
    canGoBack.value = false
    canGoForward.value = false
    return
  }
  const wv = el as unknown as Electron.WebviewTag
  wv.addEventListener('dom-ready', () => {
    ready.value = true
    attachListeners()
    updateNavState()
  }, { once: true })
})

onUnmounted(() => {
  detachListeners()
  ready.value = false
})
</script>

<template>
  <div class="site-preview">
    <div class="site-preview-toolbar">
      <div class="toolbar-nav">
        <BondButton variant="ghost" size="sm" icon :disabled="!canGoBack" @click="goBack">
          <PhArrowLeft :size="14" weight="bold" />
        </BondButton>
        <BondButton variant="ghost" size="sm" icon :disabled="!canGoForward" @click="goForward">
          <PhArrowRight :size="14" weight="bold" />
        </BondButton>
        <BondButton variant="ghost" size="sm" icon @click="reload">
          <PhArrowClockwise :size="14" weight="bold" :class="{ spinning: loading }" />
        </BondButton>
      </div>

      <div class="toolbar-url">
        <BondText size="xs" color="muted" mono truncate>{{ url }}</BondText>
      </div>

      <BondButton variant="ghost" size="sm" icon @click="close" title="Close preview">
        <PhX :size="14" weight="bold" />
      </BondButton>
    </div>

    <div v-if="loading" class="site-preview-loading-bar" />

    <webview
      v-if="url"
      ref="webviewRef"
      :src="url"
      class="site-preview-webview"
    />
    <div v-else class="site-preview-empty" />
  </div>
</template>

<style scoped>
.site-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  border-left: 1px solid var(--color-border);
}

.site-preview-toolbar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
  -webkit-app-region: drag;
}

.site-preview-toolbar > * {
  -webkit-app-region: no-drag;
}

.toolbar-nav {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  flex-shrink: 0;
}

.toolbar-url {
  flex: 1;
  min-width: 0;
  height: 1.625rem;
  padding: 0.25rem 0.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.site-preview-loading-bar {
  height: 2px;
  background: var(--color-accent);
  animation: loading-pulse 1.5s ease-in-out infinite;
}

@keyframes loading-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.site-preview-webview {
  flex: 1;
  width: 100%;
  border: none;
}

.site-preview-empty {
  flex: 1;
}
</style>
