<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
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
import ChatInput from './components/ChatInput.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import MediaView from './components/MediaView.vue'
import TodoView from './components/TodoView.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'

const chat = useChat()
const sessions = useSessions()
const { activeView } = useAppView()
const { load: loadAccent, applyExternal: applyExternalAccent } = useAccentColor()

function applyWindowOpacity(val: number) {
  document.documentElement.style.setProperty('--window-bg-opacity', `${Math.round(val * 100)}%`)
}

async function loadWindowOpacity() {
  try {
    const val = await window.bond.getWindowOpacity()
    applyWindowOpacity(val)
  } catch { /* use CSS default */ }
}
const selectedModel = ref<ModelId>('sonnet')

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const chatShellRef = ref<InstanceType<typeof ViewShell> | null>(null)
const sidebarPanelRef = ref<InstanceType<typeof BondPanel> | null>(null)

function getInitialSidebarWidth(): number {
  try {
    const raw = localStorage.getItem('bond:panels:app-layout')
    if (raw) {
      const layout = JSON.parse(raw)
      if (layout.sizes?.sidebar != null) return layout.sizes.sidebar
    }
  } catch {}
  return 260
}

const sidebarCollapsed = ref(localStorage.getItem('bond:sidebar-collapsed') === '1')
const sidebarWidth = ref(getInitialSidebarWidth())

const sidebarStyle = computed(() => ({
  marginLeft: sidebarCollapsed.value ? `-${sidebarWidth.value}px` : '0',
  transition: `margin-left var(--transition-base)`,
}))

function handleToggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  localStorage.setItem('bond:sidebar-collapsed', sidebarCollapsed.value ? '1' : '0')
}

function handleLayoutChange(layout: Record<string, number>) {
  if (layout.sidebar != null) sidebarWidth.value = layout.sidebar
}

function handleLayoutChanged(layout: Record<string, number>) {
  if (layout.sidebar != null) sidebarWidth.value = layout.sidebar
}
const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { isAtBottom, scrollToBottom } = useAutoScroll(scrollEl)

let titleGenPending = false

chat.onQueryEnd((sessionId) => {
  if (
    sessionId === sessions.activeSessionId.value &&
    sessions.activeSession.value?.title === 'New chat' &&
    !titleGenPending
  ) {
    titleGenPending = true
    sessions.refreshTitle(sessionId).finally(() => {
      titleGenPending = false
    })
  }
})

async function handleSubmit(text: string, images: AttachedImage[]) {
  nextTick(scrollToBottom)
  await chat.submit(text, images?.length ? images : undefined)
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
  activeView.value = 'chat'
  const model = await window.bond.getModel() as ModelId
  selectedModel.value = model
  nextTick(() => chatInputRef.value?.focus())
}

async function handleCreateSkill(description: string) {
  const session = await sessions.create()
  await chat.loadSession(session.id)
  activeView.value = 'chat'
  nextTick(() => {
    const prompt = `Create a new Bond skill based on this description:\n\n${description}\n\nWrite the SKILL.md file to ~/.bond/skills/ with a good name, clear description, and useful instructions. After creating it, tell me the skill name so I know how to use it.`
    chat.submit(prompt)
  })
}

let removeCreateSkillListener: (() => void) | null = null
let removeOpacityListener: (() => void) | null = null
let removeAccentListener: (() => void) | null = null
let removeModelListener: (() => void) | null = null

async function handleSelectSession(id: string) {
  activeView.value = 'chat'
  if (id === sessions.activeSessionId.value) return
  sessions.select(id)
  await chat.loadSession(id)
  nextTick(scrollToBottom)
}

async function handleRenameSession(id: string, title: string) {
  const updated = await window.bond.updateSession(id, { title })
  if (updated) sessions.updateLocal(id, { title })
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && chat.busy.value) {
    e.preventDefault()
    chat.cancel()
    return
  }
  if (e.metaKey && !e.shiftKey && e.key === 'b') {
    e.preventDefault()
    handleToggleSidebar()
  }
  if (e.metaKey && e.key === ',') {
    e.preventDefault()
    window.bond.openSettings()
  }
  if (e.metaKey && e.key === 'n') {
    e.preventDefault()
    handleNewSession()
  }
}

function handleBeforeUnload() {
  chat.persistMessages()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', handleBeforeUnload)
  removeCreateSkillListener = window.bond.onCreateSkill(handleCreateSkill)
  removeOpacityListener = window.bond.onWindowOpacity(applyWindowOpacity)
  removeAccentListener = window.bond.onAccentColor(applyExternalAccent)
  removeModelListener = window.bond.onModelChanged((model: string) => {
    selectedModel.value = model as ModelId
  })
  chat.subscribe()
  loadAccent()
  loadWindowOpacity()
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
  } else if (sessions.sessions.value.length === 0) {
    // True first run — no sessions at all
    await handleNewSession()
  } else {
    // All sessions archived — show empty chat without auto-creating
    activeView.value = 'chat'
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  removeCreateSkillListener?.()
  removeOpacityListener?.()
  removeAccentListener?.()
  removeModelListener?.()
  chat.persistMessages()
  chat.unsubscribe()
})
</script>

<template>
  <BondPanelGroup direction="horizontal" autoSaveId="app-layout-v2" style="width: 100%; height: 100vh;" @layoutChange="handleLayoutChange" @layoutChanged="handleLayoutChanged">
    <BondPanel ref="sidebarPanelRef" id="sidebar" unit="px" :defaultSize="260" :minSize="220" :maxSize="400" :style="sidebarStyle">
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
        @removeArchived="sessions.removeArchived"
        @media="activeView = 'media'"
        @todos="activeView = 'todos'"
        @rename="handleRenameSession"
      />
    </BondPanel>

    <BondPanelHandle v-show="!sidebarCollapsed" id="handle-0" />

    <BondPanel id="main" :defaultSize="80" :minSize="30" :minSizePx="420">
      <div :class="['main-panel-wrap', { 'sidebar-collapsed': sidebarCollapsed }]">
      <ViewShell
        v-show="activeView === 'chat'"
        ref="chatShellRef"
        :title="sessions.generatingTitleId.value === sessions.activeSessionId.value ? 'Naming...' : (sessions.activeSession.value?.title ?? 'New chat')"
        :insetStart="sidebarCollapsed"
        :titleEditable="!!sessions.activeSessionId.value && sessions.generatingTitleId.value !== sessions.activeSessionId.value"
        @rename="sessions.activeSessionId.value && handleRenameSession(sessions.activeSessionId.value, $event)"
      >
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>

        <div class="chat-content-wrap px-5 pb-10 flex flex-col gap-2.5 flex-1">
          <MessageBubble v-for="msg in chat.messages.value" :key="msg.id" :msg="msg" @approve="chat.respondToApproval" />
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

      <TodoView v-show="activeView === 'todos'" :insetStart="sidebarCollapsed">
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </TodoView>

      <MediaView v-show="activeView === 'media'" :insetStart="sidebarCollapsed">
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </MediaView>
      </div>
    </BondPanel>
  </BondPanelGroup>
</template>

<style>
@import './app.css';

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
  border-radius: var(--radius-full);
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
</style>
