<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useChat } from './composables/useChat'
import { useAutoScroll } from './composables/useAutoScroll'
import { useSessions } from './composables/useSessions'
import { useAppView } from './composables/useAppView'
import { useAccentColor } from './composables/useAccentColor'
import type { ModelId, AttachedImage } from './types/message'
import type { EditMode } from '../shared/session'
import { PhSidebarSimple, PhArrowDown } from '@phosphor-icons/vue'
import BondButton from './components/BondButton.vue'
import BondText from './components/BondText.vue'
import MessageBubble from './components/MessageBubble.vue'
import ThinkingIndicator from './components/ThinkingIndicator.vue'
import ChatInput from './components/ChatInput.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import DesignSystemView from './components/DesignSystemView.vue'
import DevComponents from './components/DevComponents.vue'
import SettingsView from './components/SettingsView.vue'
import AboutView from './components/AboutView.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'

const chat = useChat()
const sessions = useSessions()
const { activeView } = useAppView()
const { load: loadAccent } = useAccentColor()
const selectedModel = ref<ModelId>('sonnet')

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const chatShellRef = ref<InstanceType<typeof ViewShell> | null>(null)
const sidebarPanelRef = ref<InstanceType<typeof BondPanel> | null>(null)
const sidebarCollapsed = ref(false)

function handleToggleSidebar() {
  if (sidebarPanelRef.value?.isCollapsed()) {
    sidebarPanelRef.value?.expand()
    sidebarCollapsed.value = false
  } else {
    sidebarPanelRef.value?.collapse()
    sidebarCollapsed.value = true
  }
}
const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { isAtBottom, scrollToBottom } = useAutoScroll(scrollEl)

let titleGenPending = false

async function handleSubmit(text: string, images: AttachedImage[]) {
  nextTick(scrollToBottom)
  await chat.submit(text, images?.length ? images : undefined)

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

const currentEditMode = computed<EditMode>(() =>
  sessions.activeSession.value?.editMode ?? { type: 'full' }
)

function handleModelChange(model: ModelId) {
  selectedModel.value = model
  window.bond.setModel(model)
}

async function handleEditModeChange(mode: EditMode) {
  const id = sessions.activeSessionId.value
  if (!id) return
  await window.bond.updateSession(id, { editMode: mode })
  sessions.updateLocal(id, { editMode: mode })
}

async function handleNewSession() {
  const session = await sessions.create()
  await chat.loadSession(session.id)
  const model = await window.bond.getModel() as ModelId
  selectedModel.value = model
  nextTick(() => chatInputRef.value?.focus())
}

async function handleSelectSession(id: string) {
  activeView.value = 'chat'
  if (id === sessions.activeSessionId.value) return
  sessions.select(id)
  await chat.loadSession(id)
  nextTick(scrollToBottom)
}

function onKeyDown(e: KeyboardEvent) {
  if (e.metaKey && e.key === 'b') {
    e.preventDefault()
    handleToggleSidebar()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  chat.subscribe()
  loadAccent()
  nextTick(() => { sidebarCollapsed.value = sidebarPanelRef.value?.isCollapsed() ?? false })

  const [model] = await Promise.all([window.bond.getModel(), sessions.load()])
  selectedModel.value = model as ModelId

  const savedId = sessions.activeSessionId.value
  const savedSession = savedId
    ? sessions.activeSessions.value.find((s) => s.id === savedId)
    : null

  // Skip DB reload if chat state survived HMR (prevents clobbering in-flight streaming)
  const hasHmrState = chat.messages.value.length > 0 && chat.currentSessionId.value

  if (savedSession) {
    sessions.select(savedSession.id)
    if (!hasHmrState) await chat.loadSession(savedSession.id)
    nextTick(scrollToBottom)
  } else if (sessions.activeSessions.value.length > 0) {
    const first = sessions.activeSessions.value[0]
    sessions.select(first.id)
    if (!hasHmrState) await chat.loadSession(first.id)
    nextTick(scrollToBottom)
  } else {
    await handleNewSession()
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  chat.unsubscribe()
})
</script>

<template>
  <BondPanelGroup direction="horizontal" autoSaveId="app-layout" style="width: 100%; height: 100vh;" @layoutChanged="() => { sidebarCollapsed = sidebarPanelRef?.isCollapsed() ?? false }">
    <BondPanel ref="sidebarPanelRef" id="sidebar" unit="px" :defaultSize="260" :minSize="220" :maxSize="400" collapsible :collapsedSize="0">
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

    <BondPanel id="main" :defaultSize="80" :minSize="30">
      <div :class="['main-panel-wrap', { 'sidebar-collapsed': sidebarCollapsed }]">
      <ViewShell
        v-if="activeView === 'chat'"
        ref="chatShellRef"
        :title="sessions.generatingTitleId.value === sessions.activeSessionId.value ? 'Naming...' : (sessions.activeSession.value?.title ?? 'New chat')"
      >
        <template #header-left>
          <button
            type="button"
            class="sidebar-toggle-btn"
            @click.stop="handleToggleSidebar"
            :title="sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'"
          >
            <PhSidebarSimple :size="16" weight="bold" />
          </button>
        </template>

        <div class="chat-content-wrap px-5 pb-10 flex flex-col gap-2.5 flex-1">
          <MessageBubble v-for="msg in chat.messages.value" :key="msg.id" :msg="msg" @approve="chat.respondToApproval" />
          <ThinkingIndicator v-if="chat.thinking.value" />
        </div>

        <template #footer>
          <div class="chat-content-wrap px-5 relative">
            <Transition name="scroll-btn">
              <div v-if="!isAtBottom" class="scroll-to-bottom-wrap" @click="scrollToBottom">
                <BondButton variant="ghost" size="sm">
                  <PhArrowDown :size="14" />
                  <BondText size="xs" color="inherit">Bottom</BondText>
                </BondButton>
              </div>
            </Transition>
            <ChatInput ref="chatInputRef" :busy="chat.busy.value" :model="selectedModel" :editMode="currentEditMode" @submit="handleSubmit" @cancel="chat.cancel" @update:model="handleModelChange" @update:editMode="handleEditModeChange" />
          </div>
        </template>
      </ViewShell>

      <ViewShell v-else-if="activeView === 'design-system'" title="Design System">
        <template #header-left>
          <button type="button" class="sidebar-toggle-btn" @click.stop="handleToggleSidebar" :title="sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'">
            <PhSidebarSimple :size="16" weight="bold" />
          </button>
        </template>
        <DesignSystemView />
      </ViewShell>

      <ViewShell v-else-if="activeView === 'components'" title="Components">
        <template #header-left>
          <button type="button" class="sidebar-toggle-btn" @click.stop="handleToggleSidebar" :title="sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'">
            <PhSidebarSimple :size="16" weight="bold" />
          </button>
        </template>
        <DevComponents />
      </ViewShell>

      <ViewShell v-else-if="activeView === 'settings'" title="Settings">
        <template #header-left>
          <button type="button" class="sidebar-toggle-btn" @click.stop="handleToggleSidebar" :title="sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'">
            <PhSidebarSimple :size="16" weight="bold" />
          </button>
        </template>
        <SettingsView />
      </ViewShell>

      <ViewShell v-else-if="activeView === 'about'" title="About Bond">
        <template #header-left>
          <button type="button" class="sidebar-toggle-btn" @click.stop="handleToggleSidebar" :title="sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'">
            <PhSidebarSimple :size="16" weight="bold" />
          </button>
        </template>
        <AboutView />
      </ViewShell>
      </div>
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
  --color-tint: rgba(255,255,255,0.65);
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
  --color-tint: rgba(255,255,255,0.65);
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
    --color-tint: rgba(255,255,255,0.08);
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

.main-panel-wrap {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.scroll-to-bottom-wrap {
  position: absolute;
  top: -16px;
  left: 50%;
  transform: translateX(-50%) translateY(-40%);
  z-index: 5;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  cursor: pointer;
  transition: box-shadow var(--transition-base);
}
.scroll-to-bottom-wrap:hover {
  box-shadow: var(--shadow-md);
}

.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(calc(-10% + 4px));
}

.chat-content-wrap {
  width: 100%;
  max-width: 720px;
  margin-inline: auto;
}

.sidebar-toggle-btn {
  all: unset;
  cursor: pointer;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-muted);
  transition: background var(--transition-base), color var(--transition-base);
}
.sidebar-toggle-btn:hover {
  background: var(--sidebar-hover-bg);
  color: var(--color-text-primary);
}

/* When sidebar is collapsed the main panel starts at the window edge —
   push the toggle right to clear macOS traffic lights (~70px). */
.main-panel-wrap.sidebar-collapsed .view-header-left {
  left: 5.5rem;
}
</style>
