<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import QuickChat from './components/QuickChat.vue'
import { useChat } from './composables/useChat'
import { useAutoScroll } from './composables/useAutoScroll'
import { useSessions } from './composables/useSessions'
import { useProjects } from './composables/useProjects'
import { useCollections } from './composables/useCollections'
import { useJournal } from './composables/useJournal'
import { useAppView } from './composables/useAppView'
import { useAccentColor } from './composables/useAccentColor'
import { useBrowser } from './composables/useBrowser'
import { useOperatives } from './composables/useOperatives'
import { useOperativeEvents } from './composables/useOperativeEvents'
import type { ModelId, AttachedImage, Message } from './types/message'
import type { EditMode } from '../shared/session'
import { PhSidebarSimple, PhArrowDown, PhChecks, PhCube, PhGlobe, PhX, PhRobot } from '@phosphor-icons/vue'
import BondButton from './components/BondButton.vue'
import BondText from './components/BondText.vue'
import MessageBubble from './components/MessageBubble.vue'
import MissionBriefing from './components/MissionBriefing.vue'
import ChatInput from './components/ChatInput.vue'
import ActivityBar from './components/ActivityBar.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import MediaView from './components/MediaView.vue'
import ProjectsView from './components/ProjectsView.vue'
import ProjectPanelView from './components/ProjectPanelView.vue'
import CollectionsView from './components/CollectionsView.vue'
import JournalView from './components/JournalView.vue'
import TodoView from './components/TodoView.vue'
import BrowserView from './components/BrowserView.vue'
import SenseView from './components/SenseView.vue'
import OperativesView from './components/OperativesView.vue'
import OperativeDetail from './components/OperativeDetail.vue'
import OperativePanelView from './components/OperativePanelView.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'
import FieldManual from './components/FieldManual.vue'

const isQuickChatMode = new URLSearchParams(window.location.search).get('mode') === 'quick-chat'

const chat = useChat()
const sessions = useSessions()
const projects = useProjects()
const collections = useCollections()
const journal = useJournal()
const { activeView } = useAppView()
const browserComposable = useBrowser()
const operativesComposable = useOperatives()
const operativeEvents = useOperativeEvents(computed(() => operativesComposable.activeOperativeId.value))
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
const activityExpanded = ref(false)
const mediaCount = ref(0)
const fieldManualOpen = ref(false)

async function refreshMediaCount() {
  try {
    const images = await window.bond.listImages()
    mediaCount.value = images.length
  } catch { /* ignore */ }
}

type DisplayItem =
  | { type: 'message'; msg: Message }
  | { type: 'activity-group'; id: string; toolCount: number }

const displayItems = computed<DisplayItem[]>(() => {
  const msgs = chat.messages.value
  const result: DisplayItem[] = []
  let i = 0

  while (i < msgs.length) {
    const msg = msgs[i]
    if (msg.role === 'meta' && (msg.kind === 'tool' || msg.kind === 'thinking')) {
      const start = i
      let toolCount = 0
      while (i < msgs.length) {
        const m = msgs[i]
        if (m.role === 'meta' && (m.kind === 'tool' || m.kind === 'thinking')) {
          if (m.kind === 'tool') toolCount++
          i++
        } else {
          break
        }
      }
      if (i - start >= 3) {
        result.push({
          type: 'activity-group',
          id: `group-${msgs[start].id}`,
          toolCount,
        })
      } else {
        for (let k = start; k < i; k++) {
          result.push({ type: 'message', msg: msgs[k] })
        }
      }
    } else {
      result.push({ type: 'message', msg })
      i++
    }
  }

  return result
})

const browserViewRef = ref<InstanceType<typeof BrowserView> | null>(null)
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
const isFullScreen = ref(false)
const sidebarWidth = ref(getInitialSidebarWidth())

type RightPanelContent = 'todos' | 'projects' | 'browser' | 'operatives'
const rightPanelCollapsed = ref(localStorage.getItem('bond:right-panel') === 'none' || !localStorage.getItem('bond:right-panel'))
const rightPanelContent = ref<RightPanelContent>(
  (localStorage.getItem('bond:right-panel-content') as RightPanelContent) || 'todos'
)
const rightPanelOpen = computed(() => !rightPanelCollapsed.value && activeView.value === 'chat')
const rightPanelRef = ref<InstanceType<typeof BondPanel> | null>(null)

function getInitialRightPanelWidth(): number {
  try {
    const raw = localStorage.getItem('bond:panels:app-layout')
    if (raw) {
      const layout = JSON.parse(raw)
      if (layout.sizes?.['right-panel'] != null) return layout.sizes['right-panel']
    }
  } catch {}
  return 320
}
const rightPanelWidth = ref(getInitialRightPanelWidth())

const rightPanelHidden = computed(() => rightPanelCollapsed.value || activeView.value !== 'chat')

const rightPanelStyle = computed(() => ({
  marginRight: rightPanelHidden.value ? `-${rightPanelWidth.value}px` : '0',
  transition: `margin-right var(--transition-base)`,
}))

function toggleRightPanel(panel?: RightPanelContent) {
  if (panel) {
    if (!rightPanelCollapsed.value && rightPanelContent.value === panel) {
      // Same panel clicked while open — collapse
      syncRightPanelWidth()
      rightPanelCollapsed.value = true
    } else {
      // Different panel or was collapsed — open/switch
      rightPanelContent.value = panel
      rightPanelCollapsed.value = false
    }
  } else {
    // Generic toggle (keyboard shortcut)
    if (!rightPanelCollapsed.value) {
      syncRightPanelWidth()
    }
    rightPanelCollapsed.value = !rightPanelCollapsed.value
  }
  localStorage.setItem('bond:right-panel', rightPanelCollapsed.value ? 'none' : rightPanelContent.value)
  localStorage.setItem('bond:right-panel-content', rightPanelContent.value)
}

function ensureBrowserPanel() {
  if (rightPanelCollapsed.value || rightPanelContent.value !== 'browser') {
    rightPanelContent.value = 'browser'
    rightPanelCollapsed.value = false
    localStorage.setItem('bond:right-panel', 'browser')
    localStorage.setItem('bond:right-panel-content', 'browser')
  }
}

function syncRightPanelWidth() {
  const actual = rightPanelRef.value?.getSize()
  if (actual != null) rightPanelWidth.value = actual
}

const sidebarStyle = computed(() => ({
  marginLeft: sidebarCollapsed.value ? `-${sidebarWidth.value}px` : '0',
  transition: `margin-left var(--transition-base)`,
}))

function handleToggleSidebar() {
  // Sync width to actual panel size before collapsing so the negative margin fully covers it
  if (!sidebarCollapsed.value) {
    const actual = sidebarPanelRef.value?.getSize()
    if (actual != null) sidebarWidth.value = actual
  }
  sidebarCollapsed.value = !sidebarCollapsed.value
  localStorage.setItem('bond:sidebar-collapsed', sidebarCollapsed.value ? '1' : '0')
}

function handleLayoutChange(layout: Record<string, number>) {
  if (layout.sidebar != null) sidebarWidth.value = layout.sidebar
  if (layout['right-panel'] != null) rightPanelWidth.value = layout['right-panel']
}

function handleLayoutChanged(layout: Record<string, number>) {
  if (layout.sidebar != null) sidebarWidth.value = layout.sidebar
  if (layout['right-panel'] != null) rightPanelWidth.value = layout['right-panel']
}
const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { isAtBottom, scrollToBottom } = useAutoScroll(scrollEl)

let titleGenPending = false

chat.onQueryEnd((sessionId) => {
  refreshMediaCount()
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

async function handleTodoChat(text: string) {
  const session = await sessions.create()
  await chat.loadSession(session.id)
  activeView.value = 'chat'
  nextTick(() => {
    chat.submit(text)
  })
}

async function handleProjectCreate(name: string, goal: string, type: import('../shared/session').ProjectType, deadline: string) {
  await projects.create(name, goal, type, deadline || undefined)
}

async function handleProjectStartChat(projectId: string) {
  const project = projects.projects.value.find(p => p.id === projectId)
  const session = await sessions.create({ projectId })
  await chat.loadSession(session.id)
  activeView.value = 'chat'
  if (project?.goal) {
    nextTick(() => {
      chat.submit(`I'm working on the "${project.name}" project. Goal: ${project.goal}`)
    })
  } else {
    nextTick(() => chatInputRef.value?.focus())
  }
}

function handleOpenInBrowser(url: string) {
  rightPanelContent.value = 'browser'
  rightPanelCollapsed.value = false
  localStorage.setItem('bond:right-panel', 'browser')
  localStorage.setItem('bond:right-panel-content', 'browser')
  nextTick(() => browserViewRef.value?.openUrl(url))
}

let removeCreateSkillListener: (() => void) | null = null
let removeOpacityListener: (() => void) | null = null
let removeAccentListener: (() => void) | null = null
let removeModelListener: (() => void) | null = null
let removeProjectsListener: (() => void) | null = null
let removeCollectionsListener: (() => void) | null = null
let removeJournalListener: (() => void) | null = null
let removeConnectionLostListener: (() => void) | null = null
let removeConnectionRestoredListener: (() => void) | null = null
let removeFullscreenListener: (() => void) | null = null

async function handleSessionRemoved() {
  const next = sessions.activeSessionId.value
  if (next) {
    await chat.loadSession(next)
    nextTick(scrollToBottom)
  } else {
    await handleNewSession()
  }
}

async function handleArchiveSession(id: string) {
  await sessions.archive(id)
  await handleSessionRemoved()
}

async function handleRemoveSession(id: string) {
  await sessions.remove(id)
  await handleSessionRemoved()
}

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
  if (e.metaKey && e.shiftKey && e.key === 'b') {
    e.preventDefault()
    toggleRightPanel()
  }
  if (e.metaKey && e.shiftKey && e.key === 'k') {
    e.preventDefault()
    toggleRightPanel('browser')
  }
  if (e.metaKey && !e.shiftKey && e.key === 't') {
    // Only intercept Cmd+T when browser panel is open
    if (rightPanelContent.value === 'browser' && !rightPanelCollapsed.value) {
      e.preventDefault()
      browserComposable.createTab()
    }
  }
  if (e.metaKey && !e.shiftKey && e.key === 'l') {
    if (rightPanelContent.value === 'browser' && !rightPanelCollapsed.value) {
      e.preventDefault()
      browserViewRef.value?.focusUrlBar()
    }
  }
  if (e.metaKey && e.key === '/') {
    e.preventDefault()
    fieldManualOpen.value = !fieldManualOpen.value
  }
}

function handleBeforeUnload() {
  chat.stashToLocalStorage()
  chat.persistMessages()
}

function handleBrowserLinkEvent(e: Event) {
  const url = (e as CustomEvent).detail
  if (typeof url === 'string') handleOpenInBrowser(url)
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('bond:openInBrowser', handleBrowserLinkEvent)
  removeCreateSkillListener = window.bond.onCreateSkill(handleCreateSkill)
  removeOpacityListener = window.bond.onWindowOpacity(applyWindowOpacity)
  removeAccentListener = window.bond.onAccentColor(applyExternalAccent)
  removeModelListener = window.bond.onModelChanged((model: string) => {
    selectedModel.value = model as ModelId
  })
  removeProjectsListener = window.bond.onProjectsChanged(() => projects.load())
  removeCollectionsListener = window.bond.onCollectionsChanged(() => collections.load())
  removeJournalListener = window.bond.onJournalChanged(() => journal.load())
  removeConnectionLostListener = window.bond.onConnectionLost(() => {
    chat.stashToLocalStorage()
  })
  removeFullscreenListener = window.bond.onFullscreenChanged((fs: boolean) => {
    isFullScreen.value = fs
  })
  removeConnectionRestoredListener = window.bond.onConnectionRestored(async () => {
    // Re-persist all in-memory messages that survived the disconnect
    await chat.repersistAll()
    // Check if backup has messages the DB lost
    const sid = sessions.activeSessionId.value
    if (sid) {
      const restored = await chat.restoreFromBackupIfNeeded(sid)
      if (restored) await chat.loadSession(sid)
    }
  })
  chat.subscribe()
  loadAccent()
  loadWindowOpacity()
  refreshMediaCount()
  projects.load()
  collections.load()
  journal.load()
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
    if (!hasHmrState) {
      await chat.loadSession(savedSession.id)
      // Restore any messages from localStorage backup (e.g. after crash/rebuild)
      const restored = await chat.restoreFromBackupIfNeeded(savedSession.id)
      if (restored) await chat.loadSession(savedSession.id)
    }
    nextTick(scrollToBottom)
  } else if (sessions.activeSessions.value.length > 0) {
    const first = sessions.activeSessions.value[0]
    sessions.select(first.id)
    if (!hasHmrState) {
      await chat.loadSession(first.id)
      const restored = await chat.restoreFromBackupIfNeeded(first.id)
      if (restored) await chat.loadSession(first.id)
    }
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
  window.removeEventListener('bond:openInBrowser', handleBrowserLinkEvent)
  removeCreateSkillListener?.()
  removeOpacityListener?.()
  removeAccentListener?.()
  removeModelListener?.()
  removeProjectsListener?.()
  removeCollectionsListener?.()
  removeJournalListener?.()
  removeConnectionLostListener?.()
  removeConnectionRestoredListener?.()
  removeFullscreenListener?.()
  chat.stashToLocalStorage()
  chat.persistMessages()
  chat.unsubscribe()
})
</script>

<template>
  <QuickChat v-if="isQuickChatMode" />
  <BondPanelGroup v-else direction="horizontal" autoSaveId="app-layout" style="width: 100%; height: 100vh;" @layoutChange="handleLayoutChange" @layoutChanged="handleLayoutChanged">
    <BondPanel ref="sidebarPanelRef" id="sidebar" unit="px" :defaultSize="260" :minSize="220" :maxSize="400" :style="sidebarStyle">
      <SessionSidebar
        :sessions="sessions.activeSessions.value"
        :archivedSessions="sessions.archivedSessions.value"
        :activeSessionId="sessions.activeSessionId.value"
        :activeView="activeView"
        :generatingTitleId="sessions.generatingTitleId.value"
        :busySessionIds="chat.busySessionIds.value"
        :mediaCount="mediaCount"
        :projectCount="projects.activeProjects.value.length"
        :collectionCount="collections.activeCollections.value.length"
        :journalCount="journal.entries.value.length"
        :operativeRunningCount="operativesComposable.runningCount.value"
        @select="handleSelectSession"
        @create="handleNewSession"
        @archive="handleArchiveSession"
        @unarchive="sessions.unarchive"
        @favorite="sessions.favorite"
        @unfavorite="sessions.unfavorite"
        @remove="handleRemoveSession"
        @removeArchived="sessions.removeArchived"
        @projects="activeView = 'projects'"
        @collections="activeView = 'collections'"
        @journal="activeView = 'journal'"
        @media="activeView = 'media'"
        @sense="activeView = 'sense'"
        @operatives="activeView = 'operatives'"
        @rename="handleRenameSession"
        @setIconSeed="sessions.setIconSeed"
      />
    </BondPanel>

    <BondPanelHandle v-show="!sidebarCollapsed" id="handle-0" />

    <BondPanel id="main" :defaultSize="80" :minSize="30" :minSizePx="rightPanelContent === 'browser' && !rightPanelCollapsed ? 300 : 420">
      <div :class="['main-panel-wrap', { 'sidebar-collapsed': sidebarCollapsed }]">
      <ViewShell
        v-show="activeView === 'chat'"
        ref="chatShellRef"
        :title="sessions.generatingTitleId.value === sessions.activeSessionId.value ? 'Naming...' : (sessions.activeSession.value?.title ?? 'New chat')"
        :insetStart="sidebarCollapsed && !isFullScreen"
        :titleEditable="!!sessions.activeSessionId.value && sessions.generatingTitleId.value !== sessions.activeSessionId.value"
        @rename="sessions.activeSessionId.value && handleRenameSession(sessions.activeSessionId.value, $event)"
      >
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
        <template #header-end>
          <BondButton variant="ghost" size="sm" icon :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'projects' }" @click.stop="toggleRightPanel('projects')" v-tooltip="'Projects panel'">
            <PhCube :size="16" weight="bold" />
          </BondButton>
          <BondButton variant="ghost" size="sm" icon :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'todos' }" @click.stop="toggleRightPanel('todos')" v-tooltip="'Todos panel ⇧⌘B'">
            <PhChecks :size="16" weight="bold" />
          </BondButton>
          <BondButton variant="ghost" size="sm" icon :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'operatives' }" @click.stop="toggleRightPanel('operatives')" v-tooltip="'Operatives panel'">
            <PhRobot :size="16" weight="bold" />
          </BondButton>
          <BondButton variant="ghost" size="sm" icon :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'browser' }" @click.stop="toggleRightPanel('browser')" v-tooltip="'Browser panel ⇧⌘K'">
            <PhGlobe :size="16" weight="bold" />
          </BondButton>
        </template>

        <div class="chat-content-wrap px-5 pb-10 flex flex-col gap-2.5 flex-1">
          <MissionBriefing v-if="chat.messages.value.length === 0" />
          <template v-else>
            <template v-for="item in displayItems" :key="item.type === 'message' ? item.msg.id : item.id">
              <span
                v-if="item.type === 'activity-group'"
                class="activity-group-summary"
                @click="activityExpanded = true"
              >Used {{ item.toolCount }} {{ item.toolCount === 1 ? 'tool' : 'tools' }}</span>
              <MessageBubble
                v-else
                :msg="item.msg"
                @approve="chat.respondToApproval"
                @openActivity="activityExpanded = true"
              />
            </template>
          </template>
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
            <TransitionGroup name="queued" tag="div" class="queued-list">
              <div v-for="msg in chat.currentQueue.value" :key="msg.id" class="queued-item" @click="chat.removeQueuedMessage(msg.id); chatInputRef?.setText(msg.text)">
                <BondText size="xs" color="muted" truncate class="flex-1 min-w-0">{{ msg.text }}</BondText>
                <button class="queued-dismiss" @click.stop="chat.removeQueuedMessage(msg.id)" v-tooltip="'Remove from queue'">
                  <PhX :size="10" />
                </button>
              </div>
            </TransitionGroup>
            <ChatInput ref="chatInputRef" :busy="chat.busy.value" :model="selectedModel" :editMode="currentEditMode" :trimBottom="chat.activity.value.type !== 'idle'" @submit="handleSubmit" @cancel="chat.cancel" @update:model="handleModelChange" @update:editMode="handleEditModeChange" />
            <ActivityBar :activity="chat.activity.value" v-model:expanded="activityExpanded" />
          </div>
        </template>
      </ViewShell>

      <ProjectsView
        v-show="activeView === 'projects'"
        :projects="projects.activeProjects.value"
        :archivedProjects="projects.archivedProjects.value"
        :activeProjectId="projects.activeProjectId.value"
        :insetStart="sidebarCollapsed && !isFullScreen"
        @select="projects.select"
        @create="handleProjectCreate"
        @archive="projects.archive"
        @unarchive="projects.unarchive"
        @remove="projects.remove"
        @addResource="projects.addResource"
        @removeResource="projects.removeResource"
        @updateDeadline="(id, d) => projects.update(id, { deadline: d })"
        @startChat="handleProjectStartChat"
        @back="projects.select(null)"
      >
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </ProjectsView>

      <CollectionsView
        v-show="activeView === 'collections'"
        :collections="collections.activeCollections.value"
        :archivedCollections="collections.archivedCollections.value"
        :activeCollectionId="collections.activeCollectionId.value"
        :insetStart="sidebarCollapsed && !isFullScreen"
        @select="collections.select"
        @archive="collections.archive"
        @unarchive="collections.unarchive"
        @remove="collections.remove"
        @back="collections.select(null)"
      >
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </CollectionsView>

      <JournalView
        v-show="activeView === 'journal'"
        :entries="journal.entries.value"
        :activeEntryId="journal.activeEntryId.value"
        :generatingMetaId="journal.generatingMetaId.value"
        :generatingBondCommentId="journal.generatingBondCommentId.value"
        :loading="journal.loading.value"
        :insetStart="sidebarCollapsed && !isFullScreen"
        @select="journal.select"
        @createAndGenerate="journal.createAndGenerate"
        @update="journal.update"
        @remove="journal.remove"
        @search="journal.search"
        @load="journal.load"
        @togglePin="journal.togglePin"
        @addComment="journal.addComment"
        @deleteComment="journal.deleteComment"
        @requestBondComment="journal.requestBondComment"
      >
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </JournalView>

      <MediaView v-show="activeView === 'media'" :insetStart="sidebarCollapsed && !isFullScreen">
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </MediaView>

      <SenseView v-show="activeView === 'sense'" :insetStart="sidebarCollapsed && !isFullScreen">
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
      </SenseView>

      <template v-if="activeView === 'operatives'">
        <OperativeDetail
          v-if="operativesComposable.activeOperative.value"
          :operative="operativesComposable.activeOperative.value"
          :events="operativeEvents.events.value"
          @cancel="operativesComposable.cancel"
          @remove="(id) => { operativesComposable.remove(id); operativesComposable.select(null) }"
          @back="operativesComposable.select(null)"
        >
          <template #header-start>
            <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
              <PhSidebarSimple :size="16" weight="bold" />
            </BondButton>
          </template>
        </OperativeDetail>
        <OperativesView
          v-else
          :operatives="operativesComposable.operatives.value"
          :activeOperativeId="operativesComposable.activeOperativeId.value"
          :insetStart="sidebarCollapsed && !isFullScreen"
          @select="operativesComposable.select"
          @cancel="operativesComposable.cancel"
          @remove="operativesComposable.remove"
          @clear="operativesComposable.clear"
        >
          <template #header-start>
            <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
              <PhSidebarSimple :size="16" weight="bold" />
            </BondButton>
          </template>
        </OperativesView>
      </template>
      </div>
    </BondPanel>

    <BondPanelHandle v-show="!rightPanelHidden" id="handle-1" />

    <BondPanel ref="rightPanelRef" id="right-panel" unit="px" :defaultSize="320" :minSize="rightPanelContent === 'browser' ? 360 : 260" :maxSize="99999" :style="rightPanelStyle">
      <TodoView v-if="rightPanelContent === 'todos'" @startChat="handleTodoChat" />
      <ProjectPanelView v-else-if="rightPanelContent === 'projects'"
        :projects="projects.activeProjects.value"
        :activeProjectId="projects.activeProjectId.value"
        @select="projects.select"
        @startChat="handleProjectStartChat"
        @addResource="projects.addResource"
        @removeResource="projects.removeResource"
      />
      <OperativePanelView v-else-if="rightPanelContent === 'operatives'"
        :operatives="operativesComposable.operatives.value"
        :activeOperativeId="operativesComposable.activeOperativeId.value"
        :events="operativeEvents.events.value"
        @select="operativesComposable.select"
        @cancel="operativesComposable.cancel"
        @remove="operativesComposable.remove"
      />
      <!-- BrowserView uses v-show so webview tabs stay alive when panel switches -->
      <BrowserView v-show="rightPanelContent === 'browser'" ref="browserViewRef" @ensureVisible="ensureBrowserPanel" />
    </BondPanel>
  </BondPanelGroup>

  <FieldManual v-if="!isQuickChatMode" :open="fieldManualOpen" @close="fieldManualOpen = false" />
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

.activity-group-summary {
  display: block;
  text-align: center;
  font-size: 11px;
  color: var(--color-muted);
  opacity: 0.55;
  cursor: pointer;
  padding: 2px 0;
  transition: opacity var(--transition-fast);
}
.activity-group-summary:hover {
  opacity: 0.85;
}

.panel-toggle-active {
  color: var(--color-accent, var(--color-text-primary)) !important;
}

.queued-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.queued-list:has(.queued-item) {
  padding: 4px 0;
}
.queued-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: var(--radius-md);
  background: var(--color-tint);
  cursor: pointer;
}
.queued-item:hover {
  background: var(--color-border);
}
.queued-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--color-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
}
.queued-dismiss:hover {
  color: var(--color-text-primary);
}
.queued-enter-active,
.queued-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.queued-enter-from,
.queued-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
