<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import QuickChat from './components/QuickChat.vue'
import { useChat } from './composables/useChat'
import { useAutoScroll } from './composables/useAutoScroll'
import { useCollections } from './composables/useCollections'
import { useAccentColor } from './composables/useAccentColor'
import type { ModelId, AttachedImage, Message } from './types/message'
import type { EditMode } from '../shared/session'
import { PhArrowDown, PhX, PhListBullets, PhClockCounterClockwise, PhImages, PhBrain } from '@phosphor-icons/vue'
import BondButton from './components/BondButton.vue'
import BondText from './components/BondText.vue'
import MessageBubble from './components/MessageBubble.vue'
import MissionBriefing from './components/MissionBriefing.vue'
import ChatInput from './components/ChatInput.vue'
import ApprovalPrompt from './components/ApprovalPrompt.vue'
import MediaView from './components/MediaView.vue'
import CollectionsView from './components/CollectionsView.vue'
import SensePanelView from './components/SensePanelView.vue'
import MemoryView from './components/MemoryView.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'
import FieldManual from './components/FieldManual.vue'
import { shouldPersistOnUnload } from './lib/persistGuard'
import { playTypewriter } from './lib/typewriter'

const isQuickChatMode = new URLSearchParams(window.location.search).get('mode') === 'quick-chat'

const chat = useChat()
const collections = useCollections()
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
const selectedModel = ref<ModelId>('balanced')
const mediaCount = ref(0)
const fieldManualOpen = ref(false)
// True while the daemon is serving the isolated new-user sandbox data set.
// The app behaves identically — this only drives persistence guards.
const sandboxed = ref(false)

// First-run intro reveal. Nothing is ever hidden or swapped: the real
// transcript renders normally, and while `revealText` is non-null the intro
// message's text is overridden with a progressively growing prefix, so it
// streams in exactly like any other Bond reply. The composer waits below the
// window edge while the text streams, then rises in and takes focus.
const revealText = ref<string | null>(null)
const revealStreaming = ref(false)
// True while first-run onboarding (interview or panel tour) is still open —
// drives the contextual composer placeholder. Re-checked after every turn
// (stage transitions happen daemon-side via tools, invisible to the renderer).
const onboardingActive = ref(false)
const ONBOARDING_OPEN_STATUSES = ['pending', 'education']
const composerPlaceholder = computed<string | undefined>(() => {
  if (!onboardingActive.value) return undefined
  const hasAnswered = chat.messages.value.some(msg => msg.role === 'user')
  return hasAnswered ? 'Your answer…' : 'Your name…'
})

// Composer entrance phase. The flight transform lives INSIDE .composer-clip
// (overflow: clip), so the offstage composer can never contribute scrollable
// overflow to the chat scroll area. That phantom overflow is what previously
// let the boot scrollToBottom() shove the intro message out of the viewport
// and drag it back down during the flight — the transcript physically cannot
// move now.
const composerPhase = ref<'hidden' | 'entering' | 'done'>('done')
// Suppresses MissionBriefing until onboarding status is known, so a genuinely
// fresh install doesn't flash the welcome screen before the entrance begins.
const bootStatusKnown = ref(false)

const displayMessages = computed<Message[]>(() => {
  if (revealText.value === null) return chat.messages.value
  return chat.messages.value.map(msg =>
    msg.role === 'bond' && msg.id === 'onboarding-intro'
      ? { ...msg, text: revealText.value as string, streaming: revealStreaming.value }
      : msg
  )
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// The text reveal is plain streaming and is COMPLETELY finished (revealText
// back to null, override released) before the composer moves. Only the
// composer animates, and its flight is gated in CSS via prefers-reduced-motion.
async function playEntrance(introText: string) {
  revealText.value = ''
  revealStreaming.value = true
  composerPhase.value = 'hidden'
  await playTypewriter(introText, text => {
    revealText.value = text
  })
  revealStreaming.value = false
  revealText.value = null
  await delay(250)
  composerPhase.value = 'entering'
  await delay(700)
  composerPhase.value = 'done'
  chatInputRef.value?.focus()
}

// The interview ends daemon-side (complete_onboarding tool), so re-check when
// each turn finishes and drop the contextual placeholder once it's done.
watch(() => chat.busy.value, async (busy) => {
  if (busy || !onboardingActive.value) return
  try {
    onboardingActive.value = ONBOARDING_OPEN_STATUSES.includes((await window.bond.onboardingStatus()).status)
  } catch { /* keep the current placeholder */ }
})

async function refreshMediaCount() {
  try {
    const images = await window.bond.listImages()
    mediaCount.value = images.length
  } catch { /* ignore */ }
}

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const chatShellRef = ref<InstanceType<typeof ViewShell> | null>(null)
const isFullScreen = ref(false)

type RightPanelContent = 'collections' | 'sense' | 'media' | 'memory'
const validRightPanels: RightPanelContent[] = ['collections', 'sense', 'media', 'memory']
function savedRightPanelContent(): RightPanelContent {
  const saved = localStorage.getItem('bond:right-panel-content') as RightPanelContent | null
  return saved && validRightPanels.includes(saved) ? saved : 'collections'
}
const rightPanelCollapsed = ref(localStorage.getItem('bond:right-panel') === 'none' || !localStorage.getItem('bond:right-panel'))
const rightPanelContent = ref<RightPanelContent>(savedRightPanelContent())
const rightPanelOpen = computed(() => !rightPanelCollapsed.value)
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

const rightPanelHidden = computed(() => rightPanelCollapsed.value)

const rightPanelStyle = computed(() => ({
  marginRight: rightPanelHidden.value ? `-${rightPanelWidth.value}px` : '0',
  transition: `margin-right var(--transition-base)`,
}))

// Onboarding tour show_panel tool → open (never toggle-close) a panel.
function handleShowPanel(event: Event) {
  const panel = (event as CustomEvent<string>).detail as RightPanelContent
  if (!validRightPanels.includes(panel)) return
  rightPanelContent.value = panel
  rightPanelCollapsed.value = false
  localStorage.setItem('bond:right-panel', panel)
  localStorage.setItem('bond:right-panel-content', panel)
}

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

function syncRightPanelWidth() {
  const actual = rightPanelRef.value?.getSize()
  if (actual != null) rightPanelWidth.value = actual
}

function handleLayoutChange(layout: Record<string, number>) {
  if (layout['right-panel'] != null) rightPanelWidth.value = layout['right-panel']
}

function handleLayoutChanged(layout: Record<string, number>) {
  if (layout['right-panel'] != null) rightPanelWidth.value = layout['right-panel']
}
const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { isAtBottom, scrollToBottom } = useAutoScroll(scrollEl)

chat.onQueryEnd(() => {
  refreshMediaCount()
})

function handleCancel() {
  chat.cancel()
}

async function handleSubmit(text: string, images: AttachedImage[]) {
  nextTick(scrollToBottom)
  await chat.submit(text, images?.length ? images : undefined)
}

function approvalContext(): string | undefined {
  return undefined
}

function handleModelChange(model: ModelId) {
  selectedModel.value = model
  window.bond.setModel(model)
}

function handleEditModeChange(mode: EditMode) {
  chat.setEditMode(mode)
  window.bond.setEditMode(mode)
}


async function handleCreateSkill(description: string) {
  await chat.init()
  nextTick(() => {
    const prompt = `Create a new Bond skill based on this description:\n\n${description}\n\nWrite the SKILL.md file to ~/.bond/skills/ with a good name, clear description, and useful instructions. After creating it, tell me the skill name so I know how to use it.`
    chat.submit(prompt)
  })
}


let removeCreateSkillListener: (() => void) | null = null
let removeOpacityListener: (() => void) | null = null
let removeAccentListener: (() => void) | null = null
let removeModelListener: (() => void) | null = null
let removeCollectionsListener: (() => void) | null = null
let removeConnectionLostListener: (() => void) | null = null
let removeConnectionRestoredListener: (() => void) | null = null
let removeFullscreenListener: (() => void) | null = null

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && chat.busy.value) {
    e.preventDefault()
    chat.cancel()
    return
  }
  if (e.metaKey && e.key === ',') {
    e.preventDefault()
    window.bond.openSettings()
  }
  if (e.metaKey && e.shiftKey && e.key === 'b') {
    e.preventDefault()
    toggleRightPanel()
  }
  if (e.metaKey && e.key === '/') {
    e.preventDefault()
    fieldManualOpen.value = !fieldManualOpen.value
  }
}

function handleBeforeUnload() {
  // Never persist across the sandbox boundary: not while sandboxed, and not
  // while main is mid-swap (it sets the suppress flag before swapping data).
  if (!shouldPersistOnUnload(sandboxed.value)) return
  chat.stashToLocalStorage()
  chat.persistMessages()
}


onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('bond:show-panel', handleShowPanel)
  removeCreateSkillListener = window.bond.onCreateSkill(handleCreateSkill)
  removeOpacityListener = window.bond.onWindowOpacity(applyWindowOpacity)
  removeAccentListener = window.bond.onAccentColor(applyExternalAccent)
  removeModelListener = window.bond.onModelChanged((model: string) => {
    selectedModel.value = model as ModelId
  })
  removeCollectionsListener = window.bond.onCollectionsChanged(() => collections.load())
  removeConnectionLostListener = window.bond.onConnectionLost(() => {
    if (!sandboxed.value) chat.stashToLocalStorage()
  })
  removeFullscreenListener = window.bond.onFullscreenChanged((fs: boolean) => {
    isFullScreen.value = fs
  })
  removeConnectionRestoredListener = window.bond.onConnectionRestored(async () => {
    if (sandboxed.value) return
    await chat.repersistAll()
    const restored = await chat.restoreFromBackupIfNeeded()
    if (restored) await chat.loadTranscript()
  })
  chat.subscribe()
  try {
    sandboxed.value = (await window.bond.sandboxStatus()).sandboxed
  } catch { /* older daemon without sandbox support */ }
  let firstRunPending = false
  try {
    // A genuinely fresh install (or the sandbox, which looks identical) gets
    // Bond's intro seeded as the first real transcript message; the interview
    // itself is the normal agent driven by the first-run system prompt.
    const onboardingState = await window.bond.onboardingStatus()
    console.log(`[entrance] boot: onboarding=${onboardingState.status} sandboxed=${sandboxed.value}`)
    // A reload mid-interview OR mid-tour still counts as onboarding-open.
    onboardingActive.value = ONBOARDING_OPEN_STATUSES.includes(onboardingState.status)
    if (onboardingState.status === 'pending') {
      firstRunPending = true
      // Hold the intro empty and the composer offstage from the first paint.
      revealText.value = ''
      revealStreaming.value = true
      composerPhase.value = 'hidden'
      await window.bond.onboardingBegin()
    }
  } catch (error) {
    console.log(`[entrance] boot: status check failed — ${error instanceof Error ? error.message : String(error)}`)
  }
  bootStatusKnown.value = true
  loadAccent()
  loadWindowOpacity()
  refreshMediaCount()
  collections.load()
  const model = await window.bond.getModel()
  selectedModel.value = model as ModelId
  try {
    chat.setEditMode(await window.bond.getEditMode())
  } catch { /* default full */ }
  if (chat.messages.value.length === 0) {
    await chat.init()
    // The localStorage stash is emergency recovery for the REAL transcript;
    // restoring it inside the sandbox would leak real data into the simulation.
    const restored = sandboxed.value ? false : await chat.restoreFromBackupIfNeeded()
    if (restored) await chat.loadTranscript()
  } else {
    await chat.init()
  }
  if (firstRunPending) {
    // Play the entrance only for the untouched opener — a reload mid-interview
    // shows the transcript normally.
    const first = chat.messages.value[0]
    console.log(`[entrance] gate: count=${chat.messages.value.length} first=${first ? `${first.role}/${first.id}/${'text' in first ? (first.text?.length ?? 0) : 'n/a'}ch` : 'none'}`)
    if (chat.messages.value.length === 1 && first?.role === 'bond' && first.text) {
      void playEntrance(first.text)
    } else {
      console.log('[entrance] gate failed — showing transcript normally')
      revealText.value = null
      revealStreaming.value = false
      composerPhase.value = 'done'
    }
  }
  nextTick(scrollToBottom)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('bond:show-panel', handleShowPanel)
  removeCreateSkillListener?.()
  removeOpacityListener?.()
  removeAccentListener?.()
  removeModelListener?.()
  removeCollectionsListener?.()
  removeConnectionLostListener?.()
  removeConnectionRestoredListener?.()
  removeFullscreenListener?.()
  if (shouldPersistOnUnload(sandboxed.value)) {
    chat.stashToLocalStorage()
    chat.persistMessages()
  }
  chat.unsubscribe()
})
</script>

<template>
  <QuickChat v-if="isQuickChatMode" />
  <template v-else>
  <BondPanelGroup direction="horizontal" autoSaveId="app-layout" style="width: 100%; height: 100vh;" @layoutChange="handleLayoutChange" @layoutChanged="handleLayoutChanged">
    <BondPanel id="main" :defaultSize="80" :minSize="30" :minSizePx="420">
      <div class="main-panel-wrap">
      <ViewShell
        ref="chatShellRef"
        title="Bond"
        :insetStart="!isFullScreen"
      >
        <div class="chat-content-wrap px-5 pb-10 flex flex-col gap-2.5 flex-1">
          <!-- revealText !== null means the first-run entrance owns the screen:
               MissionBriefing must never mount during it. Its 100vh-tall exit
               transition shoves the streaming intro below the fold. -->
          <MissionBriefing v-if="bootStatusKnown && revealText === null && chat.messages.value.length === 0" />
          <template v-else>
            <MessageBubble
              v-for="msg in displayMessages"
              :key="msg.id"
              :msg="msg"
              @approve="chat.respondToApproval"
            />
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
            <div v-if="chat.pendingApprovals.value.length" class="approval-stack">
              <ApprovalPrompt
                v-for="approval in chat.pendingApprovals.value"
                :key="approval.requestId"
                :requestId="approval.requestId"
                :toolName="approval.toolName"
                :input="approval.input"
                :description="approval.description"
                :context="approvalContext(approval.sessionId)"
                @respond="chat.respondToApproval"
              />
            </div>
            <!-- .composer-clip clips the offstage composer so its transformed
                 box can't create scrollable overflow (which would shift the
                 transcript). The flight classes live on the inner wrapper;
                 both are inert in steady state. -->
            <div class="composer-clip">
              <div
                :class="{
                  'composer-offstage': composerPhase === 'hidden',
                  'composer-entering': composerPhase === 'entering',
                }"
              >
                <ChatInput ref="chatInputRef" :busy="chat.busy.value" :model="selectedModel" :editMode="chat.editMode.value" :contextUsage="chat.contextUsage.value" :placeholder="composerPlaceholder" @submit="handleSubmit" @cancel="handleCancel" @update:model="handleModelChange" @update:editMode="handleEditModeChange" />
              </div>
            </div>
          </div>
        </template>
      </ViewShell>
      </div>
    </BondPanel>

    <BondPanelHandle v-show="!rightPanelHidden" id="handle-0" />

    <BondPanel ref="rightPanelRef" id="right-panel" class="right-panel" unit="px" :defaultSize="320" :minSize="['sense', 'memory'].includes(rightPanelContent) ? 300 : 260" :maxSize="99999" :style="rightPanelStyle">
      <CollectionsView v-if="rightPanelContent === 'collections'"
        :collections="collections.activeCollections.value"
        :archivedCollections="collections.archivedCollections.value"
        :activeCollectionId="collections.activeCollectionId.value"
        @select="collections.select($event)"
        @archive="collections.archive($event)"
        @unarchive="collections.unarchive($event)"
        @remove="collections.remove($event)"
        @back="collections.select(null)"
      />
      <SensePanelView v-else-if="rightPanelContent === 'sense'" />
      <MemoryView v-else-if="rightPanelContent === 'memory'" />
      <MediaView v-else-if="rightPanelContent === 'media'" />
    </BondPanel>
  </BondPanelGroup>

  <!-- Order mirrors the onboarding tour: Sense, Media, Memory, Collections. -->
  <nav class="right-panel-controls no-drag" aria-label="Panel views">
    <BondButton
      variant="ghost"
      size="sm"
      icon
      :aria-label="rightPanelOpen && rightPanelContent === 'sense' ? 'Close Sense panel' : 'Open Sense panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'sense' }"
      @click.stop="toggleRightPanel('sense')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'sense' ? 'Close Sense' : 'Sense'"
    >
      <PhClockCounterClockwise :size="16" weight="bold" />
    </BondButton>
    <BondButton
      variant="ghost"
      size="sm"
      icon
      :aria-label="rightPanelOpen && rightPanelContent === 'media' ? 'Close Media panel' : 'Open Media panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'media' }"
      @click.stop="toggleRightPanel('media')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'media' ? 'Close Media' : `Media${mediaCount ? ` (${mediaCount})` : ''}`"
    >
      <PhImages :size="16" weight="bold" />
    </BondButton>
    <BondButton
      variant="ghost"
      size="sm"
      icon
      :aria-label="rightPanelOpen && rightPanelContent === 'memory' ? 'Close Memory panel' : 'Open Memory panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'memory' }"
      @click.stop="toggleRightPanel('memory')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'memory' ? 'Close Memory' : 'Memory'"
    >
      <PhBrain :size="16" weight="bold" />
    </BondButton>
    <BondButton
      variant="ghost"
      size="sm"
      icon
      :aria-label="rightPanelOpen && rightPanelContent === 'collections' ? 'Close Collections panel' : 'Open Collections panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'collections' }"
      @click.stop="toggleRightPanel('collections')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'collections' ? 'Close Collections' : 'Collections'"
    >
      <PhListBullets :size="16" weight="bold" />
    </BondButton>
  </nav>

  <FieldManual :open="fieldManualOpen" @close="fieldManualOpen = false" />
  </template>
</template>

<style>
@import './app.css';

.main-panel-wrap {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* Clips the offstage composer at its own slot's bounds. overflow: clip (not
   hidden) clips paint without creating a scroll container, and clipped boxes
   don't contribute to the scroll area's scrollable overflow — the guarantee
   that the transcript can't shift during the entrance. The 4px padding /
   -4px margin pair is layout-neutral and keeps the composer's 2px focus ring
   inside the clip box. */
.composer-clip {
  overflow: clip;
  padding: 4px;
  margin: -4px;
}

/* First-run entrance: after the intro has fully streamed in, the composer
   rises from below with a little depth, then takes focus. These classes are
   absent in steady state — a lingering transform/will-change here would break
   the backdrop-filter glass of the composer inside it. Under
   prefers-reduced-motion the flight is skipped (the composer just sits in
   place) while the text streaming still plays. */
@media (prefers-reduced-motion: no-preference) {
  .composer-offstage {
    transform: perspective(900px) translateY(110%) rotateX(14deg) scale(0.96);
    opacity: 0;
    pointer-events: none;
  }
  .composer-entering {
    transition:
      transform 0.7s cubic-bezier(0.3, 1.4, 0.45, 1),
      opacity 0.45s ease-out;
    transform: perspective(900px) translateY(0) rotateX(0deg) scale(1);
    opacity: 1;
  }
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

.approval-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}

.right-panel {
  position: relative;
  background: var(--color-bg);
}

.right-panel-controls {
  position: fixed;
  top: 0;
  right: 0.75rem;
  z-index: 22;
  height: var(--toolbar-height);
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.right-panel .bond-toolbar__end {
  margin-right: 8.5rem;
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

/* Overflow menu for extra panel types */
.overflow-menu {
  display: flex;
  flex-direction: column;
  padding: 0.25rem;
}

.overflow-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.625rem;
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
  width: 100%;
  text-align: left;
}
.overflow-menu-item:hover {
  background: var(--color-tint);
}
.overflow-menu-item.active {
  color: var(--color-accent, var(--color-text-primary));
}

.overflow-badge {
  margin-left: auto;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  min-width: 1.125rem;
  height: 1.125rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.3125rem;
  border-radius: 999px;
  background: var(--color-accent, var(--color-text-primary));
  color: var(--color-bg, #fff);
}
</style>
