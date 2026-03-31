<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useChat } from './composables/useChat'
import { useAutoScroll } from './composables/useAutoScroll'
import { useSessions } from './composables/useSessions'
import { useAppView } from './composables/useAppView'
import { useAccentColor } from './composables/useAccentColor'
import { useProjects } from './composables/useProjects'
import { useSitePreview } from './composables/useSitePreview'
import type { ModelId, AttachedImage } from './types/message'
import type { WordPressSite } from '../shared/wordpress'
import type { EditMode } from '../shared/session'
import { PhSidebarSimple, PhCompass, PhArrowDown } from '@phosphor-icons/vue'
import BondButton from './components/BondButton.vue'
import BondSelect from './components/BondSelect.vue'
import BondText from './components/BondText.vue'
import MessageBubble from './components/MessageBubble.vue'
import ChatInput from './components/ChatInput.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import ProjectView from './components/ProjectView.vue'
import SitePreview from './components/SitePreview.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'

const chat = useChat()
const sessions = useSessions()
const { activeView } = useAppView()
const { load: loadAccent, applyExternal: applyExternalAccent } = useAccentColor()
const projects = useProjects()
const sitePreview = useSitePreview()

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
const browserPanelRef = ref<InstanceType<typeof BondPanel> | null>(null)

watch(sitePreview.isOpen, (open) => {
  nextTick(() => {
    if (open) browserPanelRef.value?.expand()
    else browserPanelRef.value?.collapse()
  })
}, { immediate: true })



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

const siteOptions = computed(() => {
  const opts = [{ value: '', label: 'No site' }]
  for (const s of projects.sites.value) {
    opts.push({ value: s.id, label: s.name })
  }
  return opts
})

function handleLayoutChange(layout: Record<string, number>) {
  if (layout.sidebar != null) sidebarWidth.value = layout.sidebar
}

function handleLayoutChanged(layout: Record<string, number>) {
  if (layout.sidebar != null) sidebarWidth.value = layout.sidebar
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

async function handleSiteIdChange(siteId: string | undefined) {
  const id = sessions.activeSessionId.value
  if (!id) return
  await window.bond.updateSession(id, { siteId: siteId || undefined })
  sessions.updateLocal(id, { siteId: siteId || undefined })
  syncBrowserToContext()
}

async function handleNewSession() {
  const session = await sessions.create()
  await chat.loadSession(session.id)
  activeView.value = 'chat'
  syncBrowserToContext()
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
  if (id === sessions.activeSessionId.value) {
    syncBrowserToContext()
    return
  }
  sessions.select(id)
  await chat.loadSession(id)
  syncBrowserToContext()
  nextTick(scrollToBottom)
}

function handleSelectProject(site: WordPressSite) {
  projects.selectSite(site.id)
  activeView.value = 'projects'
  syncBrowserToContext()
}

async function handleChatAboutSite(site: WordPressSite) {
  // Find existing session for this site
  const existing = sessions.activeSessions.value.find(s => s.siteId === site.id)
  if (existing) {
    sessions.select(existing.id)
    await chat.loadSession(existing.id)
  } else {
    const session = await sessions.create({ siteId: site.id, title: site.name })
    await chat.loadSession(session.id)
  }
  activeView.value = 'chat'
  syncBrowserToContext()
  nextTick(() => chatInputRef.value?.focus())
}

function handleOpenProject(site: WordPressSite) {
  sitePreview.openSite(site)
}

async function handleStartPreviewSite(site: WordPressSite) {
  await projects.startSite(site.id, site.path)
  syncBrowserToContext()
}

async function handleDeleteProject(site: WordPressSite) {
  await projects.deleteSite(site.path)
  activeView.value = 'chat'
}

function getContextSite(): WordPressSite | undefined {
  if (activeView.value === 'projects') {
    return projects.selectedSite.value ?? undefined
  }
  const siteId = sessions.activeSession.value?.siteId
  if (siteId) return projects.sites.value.find(s => s.id === siteId)
  return undefined
}

function syncBrowserToContext() {
  if (!sitePreview.isOpen.value) return
  const site = getContextSite()
  if (site?.running) {
    sitePreview.openSite(site)
  } else {
    sitePreview.setSite(site ?? null)
    sitePreview.url.value = ''
  }
}

function handleToggleBrowser() {
  if (sitePreview.isOpen.value) {
    sitePreview.close()
  } else {
    const site = getContextSite()
    if (site?.running) {
      sitePreview.openSite(site)
    } else {
      // Open browser with site context (may be stopped or no site)
      sitePreview.setSite(site ?? null)
      sitePreview.isOpen.value = true
      sitePreview.url.value = ''
      localStorage.setItem('bond:site-preview-open', '1')
    }
  }
}

function onKeyDown(e: KeyboardEvent) {
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
    handleToggleBrowser()
  }
}

function handleProjectsRefresh() { projects.load() }

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('focus', handleProjectsRefresh)
  removeCreateSkillListener = window.bond.onCreateSkill(handleCreateSkill)
  removeOpacityListener = window.bond.onWindowOpacity(applyWindowOpacity)
  removeAccentListener = window.bond.onAccentColor(applyExternalAccent)
  removeModelListener = window.bond.onModelChanged((model: string) => {
    selectedModel.value = model as ModelId
  })
  chat.subscribe()
  loadAccent()
  loadWindowOpacity()
  projects.load()
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
  window.removeEventListener('focus', handleProjectsRefresh)
  removeCreateSkillListener?.()
  removeOpacityListener?.()
  removeAccentListener?.()
  removeModelListener?.()
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
        :projects="projects.sites.value"
        :projectsAvailable="projects.available.value"
        :projectsCreating="projects.creating.value"
        :selectedProjectId="projects.selectedSiteId.value"
        :togglingProjectId="projects.togglingSiteId.value"
        @select="handleSelectSession"
        @create="handleNewSession"
        @archive="sessions.archive"
        @unarchive="sessions.unarchive"
        @remove="sessions.remove"
        @removeArchived="sessions.removeArchived"
        @projectSelect="handleSelectProject"
        @projectOpen="handleOpenProject"
        @projectCreate="projects.createSite"
        @projectStart="(site: WordPressSite) => projects.startSite(site.id, site.path)"
        @projectStop="(site: WordPressSite) => projects.stopSite(site.id, site.path)"
      />
    </BondPanel>

    <BondPanelHandle v-show="!sidebarCollapsed" id="handle-0" />

    <BondPanel id="main" :defaultSize="80" :minSize="30" :minSizePx="420">
      <div :class="['main-panel-wrap', { 'sidebar-collapsed': sidebarCollapsed }]">
      <ViewShell
        v-if="activeView === 'chat'"
        ref="chatShellRef"
        :title="sessions.generatingTitleId.value === sessions.activeSessionId.value ? 'Naming...' : (sessions.activeSession.value?.title ?? 'New chat')"
        :insetStart="sidebarCollapsed"
      >
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
        <template #header-end>
          <BondSelect
            v-if="projects.sites.value.length > 0"
            :modelValue="sessions.activeSession.value?.siteId ?? ''"
            :options="siteOptions"
            variant="minimal"
            size="sm"
            @update:modelValue="handleSiteIdChange($event || undefined)"
          />
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleBrowser" v-tooltip="(sitePreview.isOpen.value ? 'Hide browser' : 'Show browser') + ' ⌘⇧B'">
            <PhCompass :size="16" weight="bold" />
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

      <ViewShell v-else-if="activeView === 'projects'" :title="projects.selectedSite.value?.name ?? 'Projects'" :insetStart="sidebarCollapsed">
        <template #header-start>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleSidebar" v-tooltip="(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + ' ⌘B'">
            <PhSidebarSimple :size="16" weight="bold" />
          </BondButton>
        </template>
        <template #header-end>
          <BondButton variant="ghost" size="sm" icon @click.stop="handleToggleBrowser" v-tooltip="(sitePreview.isOpen.value ? 'Hide browser' : 'Show browser') + ' ⌘⇧B'">
            <PhCompass :size="16" weight="bold" />
          </BondButton>
        </template>
        <ProjectView
          v-if="projects.selectedSite.value"
          :site="projects.selectedSite.value"
          :details="projects.siteDetails.value"
          :loadingDetails="projects.loadingDetails.value"
          :toggling="projects.togglingSiteId.value === projects.selectedSite.value.id"
          :deleting="projects.deleting.value"
          @start="projects.startSite(projects.selectedSite.value!.id, projects.selectedSite.value!.path)"
          @stop="projects.stopSite(projects.selectedSite.value!.id, projects.selectedSite.value!.path)"
          @chat="handleChatAboutSite(projects.selectedSite.value!)"
          @delete="handleDeleteProject(projects.selectedSite.value!)"
        />
      </ViewShell>
      </div>
    </BondPanel>

    <BondPanelHandle v-show="sitePreview.isOpen.value" id="handle-1" />

    <BondPanel
      ref="browserPanelRef"
      id="browser"
      unit="px"
      :defaultSize="500"
      :minSize="280"
      :maxSize="9999"
      collapsible
      :collapsedSize="0"
    >
      <SitePreview v-if="sitePreview.isOpen.value" @start="handleStartPreviewSite" />
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
