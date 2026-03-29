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
import SettingsView from './components/SettingsView.vue'

const chat = useChat()
const sessions = useSessions()
const { activeView } = useAppView()
const selectedModel = ref<ModelId>('sonnet')

const headerEl = ref<HTMLElement | null>(null)
const footerEl = ref<HTMLElement | null>(null)
const mainEl = ref<HTMLElement | null>(null)
const { scrollToBottom } = useAutoScroll(mainEl)

// Track whether we've generated a title for the current session's first exchange
let titleGenPending = false

function measureLayout() {
  const root = document.documentElement
  root.style.setProperty('--header-h', `${headerEl.value?.$el?.offsetHeight ?? 0}px`)
  root.style.setProperty('--footer-h', `${footerEl.value?.$el?.offsetHeight ?? 0}px`)
}

let ro: ResizeObserver | undefined

async function handleSubmit(text: string) {
  nextTick(scrollToBottom)
  await chat.submit(text)

  // After first assistant reply in a "New chat", generate a title
  if (
    sessions.activeSessionId.value &&
    sessions.activeSession.value?.title === 'New chat' &&
    chat.messages.value.length >= 2 &&
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
  if (headerEl.value?.$el) ro.observe(headerEl.value.$el)
  if (footerEl.value?.$el) ro.observe(footerEl.value.$el)

  // Sync model and load sessions concurrently
  const [model] = await Promise.all([window.bond.getModel(), sessions.load()])
  selectedModel.value = model as ModelId
  if (sessions.activeSessions.value.length > 0) {
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
  <div class="app-root">
    <SessionSidebar
      :sessions="sessions.activeSessions.value"
      :archivedSessions="sessions.archivedSessions.value"
      :activeSessionId="sessions.activeSessionId.value"
      :showArchived="sessions.showArchived.value"
      :activeView="activeView"
      @select="handleSelectSession"
      @create="handleNewSession"
      @archive="sessions.archive"
      @unarchive="sessions.unarchive"
      @remove="sessions.remove"
      @toggleArchived="sessions.showArchived.value = !sessions.showArchived.value"
      @switchView="(v) => activeView = v"
    />

    <div v-if="activeView === 'chat'" class="app-shell">
      <ChatHeader ref="headerEl" />

      <main ref="mainEl" class="app-main px-5 flex flex-col gap-2.5">
        <MessageBubble v-for="msg in chat.messages.value" :key="msg.id" :msg="msg" />
        <ThinkingIndicator v-if="chat.thinking.value" />
      </main>

      <ChatInput ref="footerEl" :busy="chat.busy.value" :model="selectedModel" @submit="handleSubmit" @cancel="chat.cancel" @update:model="handleModelChange" />
    </div>

    <DesignSystemView v-else-if="activeView === 'design-system'" />

    <DevComponents v-else-if="activeView === 'components'" @close="activeView = 'chat'" />

    <SettingsView v-else-if="activeView === 'settings'" />
  </div>
</template>
