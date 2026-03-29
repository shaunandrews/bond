<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useChat } from './composables/useChat'
import { useAutoScroll } from './composables/useAutoScroll'
import { useSessions } from './composables/useSessions'
import { useAppView } from './composables/useAppView'
import type { ModelId } from './types/message'
import ChatHeader from './components/ChatHeader.vue'
import MessageBubble from './components/MessageBubble.vue'
import ThinkingIndicator from './components/ThinkingIndicator.vue'
import ChatInput from './components/ChatInput.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import DesignSystemView from './components/DesignSystemView.vue'
import DevComponents from './components/DevComponents.vue'
import ViewHeader from './components/ViewHeader.vue'
import SettingsView from './components/SettingsView.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'

const chat = useChat()
const sessions = useSessions()
const { activeView } = useAppView()
const selectedModel = ref<ModelId>('sonnet')

// Re-measure layout when view changes (header/footer refs swap)
watch(activeView, () => nextTick(measureLayout))

const headerEl = ref<HTMLElement | null>(null)
const footerEl = ref<HTMLElement | null>(null)
const mainEl = ref<HTMLElement | null>(null)
const { scrollToBottom } = useAutoScroll(mainEl)

// Track whether we've generated a title for the current session's first exchange
let titleGenPending = false

function measureLayout() {
  const root = document.documentElement
  root.style.setProperty('--header-h', `${headerEl.value?.offsetHeight ?? 0}px`)
  root.style.setProperty('--footer-h', `${footerEl.value?.offsetHeight ?? 0}px`)
}

let ro: ResizeObserver | undefined

async function handleSubmit(text: string) {
  nextTick(scrollToBottom)
  await chat.submit(text)

  // After first reply completes, generate a title from the user's message
  if (
    sessions.activeSessionId.value &&
    sessions.activeSession.value?.title === 'New chat' &&
    !titleGenPending
  ) {
    titleGenPending = true
    sessions.refreshTitle(sessions.activeSessionId.value).finally(() => {
      titleGenPending = false
    })
  }
}

function handleModelChange(model: ModelId) {
  selectedModel.value = model
  window.bond.setModel(model)
}

async function handleNewSession() {
  const session = await sessions.create()
  await chat.loadSession(session.id)
  nextTick(() => footerEl.value?.focus())
}

async function handleSelectSession(id: string) {
  activeView.value = 'chat'
  if (id === sessions.activeSessionId.value) return
  sessions.select(id)
  await chat.loadSession(id)
  nextTick(scrollToBottom)
}

onMounted(async () => {
  chat.subscribe()
  nextTick(measureLayout)
  ro = new ResizeObserver(measureLayout)
  if (headerEl.value) ro.observe(headerEl.value)
  if (footerEl.value) ro.observe(footerEl.value)

  // Sync model and load sessions concurrently
  const [model] = await Promise.all([window.bond.getModel(), sessions.load()])
  selectedModel.value = model as ModelId

  // Restore saved session, fall back to first, or create new
  const savedId = sessions.activeSessionId.value
  const savedSession = savedId
    ? sessions.activeSessions.value.find((s) => s.id === savedId)
    : null

  if (savedSession) {
    sessions.select(savedSession.id)
    await chat.loadSession(savedSession.id)
    nextTick(scrollToBottom)
  } else if (sessions.activeSessions.value.length > 0) {
    const first = sessions.activeSessions.value[0]
    sessions.select(first.id)
    await chat.loadSession(first.id)
    nextTick(scrollToBottom)
  } else {
    await handleNewSession()
  }
  nextTick(() => footerEl.value?.focus())
})

onUnmounted(() => {
  chat.unsubscribe()
  ro?.disconnect()
})
</script>

<template>
  <BondPanelGroup direction="horizontal" autoSaveId="app-layout" style="width: 100%; height: 100vh;">
    <BondPanel id="sidebar" :defaultSize="20" :minSize="12" :maxSize="35" collapsible :collapsedSize="0">
      <SessionSidebar
        :sessions="sessions.activeSessions.value"
        :archivedSessions="sessions.archivedSessions.value"
        :activeSessionId="sessions.activeSessionId.value"
        :activeView="activeView"
        :generatingTitleId="sessions.generatingTitleId.value"
        @select="handleSelectSession"
        @create="handleNewSession"
        @archive="sessions.archive"
        @unarchive="sessions.unarchive"
        @remove="sessions.remove"
        @switchView="(v) => activeView = v"
      />
    </BondPanel>

    <BondPanelHandle id="handle-0" />

    <BondPanel id="main" :defaultSize="80" :minSize="40">
      <div v-if="activeView === 'chat'" class="app-shell">
        <header ref="headerEl" class="app-header drag-region">
          <ChatHeader :title="sessions.generatingTitleId.value === sessions.activeSessionId.value ? 'Naming...' : (sessions.activeSession.value?.title ?? 'New chat')" />
        </header>

        <main ref="mainEl" class="app-main px-5 flex flex-col gap-2.5">
          <MessageBubble v-for="msg in chat.messages.value" :key="msg.id" :msg="msg" @approve="chat.respondToApproval" />
          <ThinkingIndicator v-if="chat.thinking.value" />
        </main>

        <footer ref="footerEl" class="app-footer">
          <ChatInput :busy="chat.busy.value" :model="selectedModel" @submit="handleSubmit" @cancel="chat.cancel" @update:model="handleModelChange" />
        </footer>
      </div>

      <div v-else-if="activeView === 'design-system'" class="app-shell">
        <header ref="headerEl" class="app-header drag-region">
          <ViewHeader title="Design System" />
        </header>
        <DesignSystemView />
      </div>

      <div v-else-if="activeView === 'components'" class="app-shell">
        <header ref="headerEl" class="app-header drag-region">
          <ViewHeader title="Components" />
        </header>
        <DevComponents />
      </div>

      <div v-else-if="activeView === 'settings'" class="app-shell">
        <header ref="headerEl" class="app-header drag-region">
          <ViewHeader title="Settings" />
        </header>
        <SettingsView />
      </div>
    </BondPanel>
  </BondPanelGroup>
</template>

<style>
@import "tailwindcss";

@theme {
  --color-bg: #f6f5f2;
  --color-surface: #fff;
  --color-border: #ddd9d0;
  --color-text-primary: #1a1c1f;
  --color-muted: #5c6570;
  --color-accent: #7a5c3b;
  --color-err: #e57373;
  --color-ok: #81c784;

  --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;

  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.08);
  --shadow-lg: 0 4px 16px rgba(0,0,0,0.12);

  --transition-fast: 0.12s ease;
  --transition-base: 0.15s ease;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0f1114;
    --color-surface: #181b21;
    --color-border: #343b45;
    --color-text-primary: #e8eaed;
    --color-muted: #8b939e;
    --color-accent: #c4a07c;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.2);
    --shadow-md: 0 2px 8px rgba(0,0,0,0.3);
    --shadow-lg: 0 4px 16px rgba(0,0,0,0.4);
  }
}

:root {
  --header-h: 0px;
  --footer-h: 0px;
}

html, body, #app {
  margin: 0;
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
}

.app-shell {
  position: relative;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
}

.app-header::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  mask-image: linear-gradient(to bottom, black 50%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, black 50%, transparent);
}

.drag-region {
  -webkit-app-region: drag;
}
.no-drag {
  -webkit-app-region: no-drag;
}

.app-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
}

.app-footer::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  mask-image: linear-gradient(to top, black 50%, transparent);
  -webkit-mask-image: linear-gradient(to top, black 50%, transparent);
}

.app-main {
  flex: 1;
  overflow-y: auto;
  padding-top: calc(var(--header-h) + 1rem);
  padding-bottom: calc(var(--footer-h) + 1rem);
}
</style>
