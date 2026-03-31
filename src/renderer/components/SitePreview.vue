<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { PhArrowLeft, PhArrowRight, PhArrowClockwise, PhPlay } from '@phosphor-icons/vue'
import { useSitePreview } from '../composables/useSitePreview'
import BondToolbar from './BondToolbar.vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'

const emit = defineEmits<{
  start: [site: import('../../shared/wordpress').WordPressSite]
}>()

const { url, loading, canGoBack, canGoForward, site, navigate } = useSitePreview()

const urlInput = ref('')

watch(url, (v) => { urlInput.value = v }, { immediate: true })

function onUrlSubmit() {
  let val = urlInput.value.trim()
  if (!val) return
  if (!/^https?:\/\//i.test(val)) val = 'http://' + val
  navigate(val)
}

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
    <template v-if="url">
      <BondToolbar label="Browser navigation" border="bottom" drag>
        <template #start>
          <BondButton variant="ghost" size="sm" icon :disabled="!canGoBack" @click="goBack" v-tooltip="'Back'">
            <PhArrowLeft :size="14" weight="bold" />
          </BondButton>
          <BondButton variant="ghost" size="sm" icon :disabled="!canGoForward" @click="goForward" v-tooltip="'Forward'">
            <PhArrowRight :size="14" weight="bold" />
          </BondButton>
          <BondButton variant="ghost" size="sm" icon @click="reload" v-tooltip="'Reload'">
            <PhArrowClockwise :size="14" weight="bold" :class="{ spinning: loading }" />
          </BondButton>
        </template>
        <template #middle>
          <input
            class="toolbar-url-input"
            v-model="urlInput"
            @keydown.enter="onUrlSubmit"
            @focus="($event.target as HTMLInputElement).select()"
            spellcheck="false"
          />
        </template>
      </BondToolbar>

      <div v-if="loading" class="site-preview-loading-bar" />

      <webview
        ref="webviewRef"
        :src="url"
        class="site-preview-webview"
      />
    </template>

    <div v-else-if="site && !site.running" class="site-preview-stopped">
      <div class="site-preview-stopped-content">
        <BondText size="sm" color="muted">{{ site.name }} is not running</BondText>
        <BondButton variant="secondary" size="sm" @click="emit('start', site!)">
          <PhPlay :size="14" weight="fill" />
          Start site
        </BondButton>
      </div>
    </div>

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

.toolbar-url-input {
  width: 100%;
  min-width: 0;
  height: 1.625rem;
  padding: 0.125rem 0.5rem;
  background: var(--color-bg);
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-muted);
  outline: none;
  -webkit-app-region: no-drag;
}

.toolbar-url-input:focus {
  color: var(--color-text-primary);
  background: var(--color-surface);
  box-shadow: 0 0 0 1px var(--color-border);
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

.site-preview-stopped {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.site-preview-stopped-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.site-preview-empty {
  flex: 1;
  position: relative;
  -webkit-app-region: drag;
}
</style>
