<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useChat } from './composables/useChat'
import { useAutoScroll } from './composables/useAutoScroll'
import { useSessions } from './composables/useSessions'
import { useAppView } from './composables/useAppView'
import { useAccentColor } from './composables/useAccentColor'
import type { ModelId } from './types/message'
import MessageBubble from './components/MessageBubble.vue'
import ThinkingIndicator from './components/ThinkingIndicator.vue'
import ChatInput from './components/ChatInput.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import DesignSystemView from './components/DesignSystemView.vue'
import DevComponents from './components/DevComponents.vue'
import SettingsView from './components/SettingsView.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'

const chat = useChat()
const sessions = useSessions()
const { activeView } = useAppView()
const { load: loadAccent } = useAccentColor()
const selectedModel = ref<ModelId>('sonnet')

const chatShellRef = ref<InstanceType<typeof ViewShell> | null>(null)
const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { scrollToBottom } = useAutoScroll(scrollEl)

let titleGenPending = false

async function handleSubmit(text: string) {
  nextTick(scrollToBottom)
  await chat.submit(text)

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
  const model = await window.bond.getModel() as ModelId
  selectedModel.value = model
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
  loadAccent()

  const [model] = await Promise.all([window.bond.getModel(), sessions.load()])
  selectedModel.value = model as ModelId

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
})

onUnmounted(() => {
  chat.unsubscribe()
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
      <ViewShell
        v-if="activeView === 'chat'"
        ref="chatShellRef"
        :title="sessions.generatingTitleId.value === sessions.activeSessionId.value ? 'Naming...' : (sessions.activeSession.value?.title ?? 'New chat')"
      >
        <div class="px-5 pb-10 flex flex-col gap-2.5 flex-1">
          <MessageBubble v-for="msg in chat.messages.value" :key="msg.id" :msg="msg" @approve="chat.respondToApproval" />
          <ThinkingIndicator v-if="chat.thinking.value" />
        </div>

        <template #footer>
          <ChatInput :busy="chat.busy.value" :model="selectedModel" @submit="handleSubmit" @cancel="chat.cancel" @update:model="handleModelChange" />
        </template>
      </ViewShell>

      <ViewShell v-else-if="activeView === 'design-system'" title="Design System">
        <DesignSystemView />
      </ViewShell>

      <ViewShell v-else-if="activeView === 'components'" title="Components">
        <DevComponents />
      </ViewShell>

      <ViewShell v-else-if="activeView === 'settings'" title="Settings">
        <SettingsView />
      </ViewShell>
    </BondPanel>
  </BondPanelGroup>
</template>

<style>
@import "tailwindcss";

/* Register colors for Tailwind utility generation only — no CSS output.
   Actual values live in :root / @media blocks below so dark mode works. */
@theme reference {
  --color-bg: #f6f5f2;
  --color-surface: #fff;
  --color-border: #ddd9d0;
  --color-text-primary: #1a1c1f;
  --color-muted: #5c6570;
  --color-accent: #7a5c3b;
  --color-err: #e57373;
  --color-ok: #81c784;
}

@theme {
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

/* Light defaults (unlayered — always beats @layer theme) */
:root {
  color-scheme: light dark;

  --color-bg: #f6f5f2;
  --color-surface: #fff;
  --color-border: #ddd9d0;
  --color-text-primary: #1a1c1f;
  --color-muted: #5c6570;
  --color-accent: #7a5c3b;
  --color-err: #e57373;
  --color-ok: #81c784;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.08);
  --shadow-lg: 0 4px 16px rgba(0,0,0,0.12);

  --sidebar-border: rgba(0, 0, 0, 0.1);
  --sidebar-text: rgba(0, 0, 0, 0.8);
  --sidebar-text-muted: rgba(0, 0, 0, 0.5);
  --sidebar-text-faint: rgba(0, 0, 0, 0.4);
  --sidebar-hover-bg: rgba(0, 0, 0, 0.06);
  --sidebar-active-bg: rgba(0, 0, 0, 0.08);
  --sidebar-action-bg: rgba(255, 255, 255, 0.5);
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0f1114;
    --color-surface: #181b21;
    --color-border: #343b45;
    --color-text-primary: #e8eaed;
    --color-muted: #8b939e;
    --color-accent: #c4a07c;
    --color-err: #ef9a9a;
    --color-ok: #a5d6a7;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.2);
    --shadow-md: 0 2px 8px rgba(0,0,0,0.3);
    --shadow-lg: 0 4px 16px rgba(0,0,0,0.4);

    --sidebar-border: rgba(255, 255, 255, 0.1);
    --sidebar-text: rgba(255, 255, 255, 0.85);
    --sidebar-text-muted: rgba(255, 255, 255, 0.5);
    --sidebar-text-faint: rgba(255, 255, 255, 0.35);
    --sidebar-hover-bg: rgba(255, 255, 255, 0.08);
    --sidebar-active-bg: rgba(255, 255, 255, 0.1);
    --sidebar-action-bg: rgba(0, 0, 0, 0.3);
  }
}

html, body, #app {
  margin: 0;
  height: 100%;
  background: transparent;
  color: var(--color-text-primary);
  font-family: var(--font-sans);
}

.drag-region {
  -webkit-app-region: drag;
}
.no-drag {
  -webkit-app-region: no-drag;
}
</style>
