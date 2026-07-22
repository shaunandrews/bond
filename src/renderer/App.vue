<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useChat } from './composables/useChat'
import { useThreads } from './composables/useThreads'
import { useAutoScroll } from './composables/useAutoScroll'
import { useCollections } from './composables/useCollections'
import { useAccentColor } from './composables/useAccentColor'
import type { ModelId, AttachedImage, Message } from './types/message'
import type { EditMode } from '../shared/session'
import { windowMinWidthForPanels, panelWidthFallback, CHAT_MIN_WIDTH } from './lib/panelLayout'
import { PhArrowDown, PhX, PhListBullets, PhChatCircleText, PhClockCounterClockwise, PhBooks, PhBrain, PhCompassRose } from '@phosphor-icons/vue'
import BondButton from './components/BondButton.vue'
import BondText from './components/BondText.vue'
import MessageBubble from './components/MessageBubble.vue'
import MissionBriefing from './components/MissionBriefing.vue'
import ChatInput from './components/ChatInput.vue'
import ApprovalPrompt from './components/ApprovalPrompt.vue'
import QuestionPrompt from './components/QuestionPrompt.vue'
import LibraryView from './components/LibraryView.vue'
import CollectionsView from './components/CollectionsView.vue'
import SensePanelView from './components/SensePanelView.vue'
import MemoryView from './components/MemoryView.vue'
import DeskView from './components/DeskView.vue'
import ThreadsView from './components/ThreadsView.vue'
import ThreadPanel from './components/ThreadPanel.vue'
import ViewShell from './components/ViewShell.vue'
import BondPanelGroup from './components/BondPanelGroup.vue'
import BondPanel from './components/BondPanel.vue'
import BondPanelHandle from './components/BondPanelHandle.vue'
import FieldManual from './components/FieldManual.vue'
import { shouldPersistOnUnload } from './lib/persistGuard'
import { playTypewriter } from './lib/typewriter'

const chat = useChat()
const threads = useThreads()
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
const libraryCount = ref(0)
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
  if (chat.pendingQuestion.value) return 'Pick an option above, or type your own answer…'
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

async function refreshLibraryCount() {
  try {
    const assets = await window.bond.libraryList()
    libraryCount.value = assets.length
  } catch { /* ignore */ }
}

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const chatShellRef = ref<InstanceType<typeof ViewShell> | null>(null)
const isFullScreen = ref(false)

type RightPanelContent = 'collections' | 'sense' | 'library' | 'memory' | 'desk' | 'threads'
const validRightPanels: RightPanelContent[] = ['collections', 'sense', 'library', 'memory', 'desk', 'threads']
function savedRightPanelContent(): RightPanelContent {
  const saved = localStorage.getItem('bond:right-panel-content') as RightPanelContent | null
  return saved && validRightPanels.includes(saved) ? saved : 'collections'
}
const rightPanelCollapsed = ref(localStorage.getItem('bond:right-panel') === 'none' || !localStorage.getItem('bond:right-panel'))
const rightPanelContent = ref<RightPanelContent>(savedRightPanelContent())
const rightPanelOpen = computed(() => !rightPanelCollapsed.value)
const rightPanelRef = ref<InstanceType<typeof BondPanel> | null>(null)
const panelGroupRef = ref<InstanceType<typeof BondPanelGroup> | null>(null)

const rightPanelHidden = computed(() => rightPanelCollapsed.value)

// --- Window sizing: side panels grow/shrink the window, chat keeps its width ---
// Opening a side panel grows the OS window by that panel's width (so the chat
// panel isn't squeezed); closing shrinks it back (so the window returns to
// where it was). The native minimum tracks the open-panel set, so a chat-only
// window can shrink small while an open panel can never be crushed.

/** Native window minimum for the panels open after a change (overridable per call). */
function windowMinFor(over: { thread?: boolean; utility?: boolean } = {}): number {
  return windowMinWidthForPanels({
    thread: over.thread ?? threadPanelOpen.value,
    utility: over.utility ?? rightPanelOpen.value,
  })
}

/**
 * Grow/shrink the OS window by `deltaWidth` and set its native minimum.
 * Returns the resulting content width. A no-op on web / older bridges, where
 * it falls back to the real viewport width so the responsive rules still work.
 */
async function resizeWindow(deltaWidth: number, minimumWidth: number): Promise<number> {
  try {
    const { width } = await window.bond.resizeContent({ deltaWidth, minimumWidth })
    return width
  } catch {
    return window.innerWidth
  }
}

/** The width a side panel occupies — live from the group, else persisted, else default. */
function sidePanelWidth(id: 'thread' | 'right-panel', fallback: 'thread' | 'utility'): number {
  const live = panelGroupRef.value?.getExpandedWidth(id) ?? 0
  if (live > 0) return live
  // Not mounted yet (a conditionally-rendered panel opening) — read the size it
  // will restore to from the group's own persisted layout, else the default.
  try {
    const raw = localStorage.getItem('bond:panels:app-layout')
    const p = raw ? JSON.parse(raw) : null
    const v = p?.preCollapseSize?.[id] ?? p?.sizes?.[id]
    if (typeof v === 'number' && v > 0) return v
  } catch { /* fall through to the default */ }
  return panelWidthFallback(fallback)
}

async function openRightPanel() {
  const w = sidePanelWidth('right-panel', 'utility')
  rightPanelCollapsed.value = false
  await resizeWindow(w, windowMinFor({ utility: true }))
  rightPanelRef.value?.expand()
}

async function closeRightPanel() {
  const w = sidePanelWidth('right-panel', 'utility')
  rightPanelCollapsed.value = true
  rightPanelRef.value?.collapse()
  await resizeWindow(-w, windowMinFor({ utility: false }))
}

// Onboarding tour show_panel tool → open (never toggle-close) a panel.
function handleShowPanel(event: Event) {
  const panel = (event as CustomEvent<string>).detail as RightPanelContent
  if (!validRightPanels.includes(panel)) return
  const wasCollapsed = rightPanelCollapsed.value
  rightPanelContent.value = panel
  if (wasCollapsed) void openRightPanel()
  localStorage.setItem('bond:right-panel', panel)
  localStorage.setItem('bond:right-panel-content', panel)
}

// A Library reference's "Show in conversation" action → scroll the source
// message into view if it's in the currently-loaded transcript page.
function handleScrollToMessage(event: Event) {
  const messageId = (event as CustomEvent<string>).detail
  const el = document.getElementById(`msg-${messageId}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function toggleRightPanel(panel?: RightPanelContent) {
  // Any user-initiated toggle overrides whatever Bond auto-collapsed to make
  // room for a thread — closeThread() must never fight a choice the user
  // made in the meantime.
  utilityAutoCollapsedForThread.value = false
  const wasOpen = !rightPanelCollapsed.value
  if (panel) {
    if (wasOpen && rightPanelContent.value === panel) {
      void closeRightPanel() // same panel clicked while open — close it
    } else if (wasOpen) {
      rightPanelContent.value = panel // switch content, panel stays the same width
    } else {
      rightPanelContent.value = panel
      void openRightPanel()
    }
  } else {
    // Generic toggle (keyboard shortcut)
    if (wasOpen) void closeRightPanel()
    else void openRightPanel()
  }
  // open/closeRightPanel set rightPanelCollapsed synchronously before awaiting,
  // so this reflects the post-toggle state.
  localStorage.setItem('bond:right-panel', rightPanelCollapsed.value ? 'none' : rightPanelContent.value)
  localStorage.setItem('bond:right-panel-content', rightPanelContent.value)
}

// --- Chat threads: middle panel ---
const threadPanelOpen = computed(() => threads.activeThreadId.value !== null)
// True only while Bond itself collapsed the utility panel to make room for a
// thread — toggleRightPanel() clears this the instant the user acts, so
// closeThread() never re-expands a panel the user deliberately closed.
const utilityAutoCollapsedForThread = ref(false)
const threadAutoFocus = ref(true)

/**
 * A thread always opens as a column and the window grows to fit it — never a
 * full-window drawer that hides the conversation. The window widens to at
 * least chat + thread (and keeps the utility panel too when it fits), only
 * collapsing utility if the display itself is too narrow for all three.
 */
async function ensureThreadWindowFit() {
  const threadW = sidePanelWidth('thread', 'thread')
  const utilityOpen = rightPanelOpen.value
  const columnsMin = windowMinWidthForPanels({ thread: true, utility: utilityOpen })
  // Grow for the thread column while keeping chat's width; force the window to
  // at least the combined column minimum so the thread is always a panel.
  const width = await resizeWindow(threadW, columnsMin)

  // Only when the display itself can't fit every column (the forced minimum
  // got clamped to the work area) do we collapse the utility panel.
  if (utilityOpen && width < columnsMin - 1) {
    const utilW = sidePanelWidth('right-panel', 'utility')
    utilityAutoCollapsedForThread.value = true
    rightPanelCollapsed.value = true
    rightPanelRef.value?.collapse()
    await resizeWindow(-utilW, windowMinWidthForPanels({ thread: true, utility: false }))
  }
}

async function openThread(anchorMessageId: string) {
  // A failed thread.create leaves activeThreadId untouched — nothing to fit
  // a window around, and the error already surfaced next to the Discuss
  // button that was clicked (useThreads.createErrorFor).
  const wasOpen = threadPanelOpen.value
  const thread = await threads.openThread(anchorMessageId)
  if (!thread) return
  // Only size the window when a thread wasn't already open — switching between
  // threads reuses the existing column and must not grow the window again.
  if (!wasOpen) await ensureThreadWindowFit()
}

/** A row picked in the Threads panel — open by id, same window-fit rules as Discuss. */
async function openThreadFromList(threadId: string) {
  const wasOpen = threadPanelOpen.value
  const thread = await threads.openThreadById(threadId)
  if (!thread) return
  if (!wasOpen) await ensureThreadWindowFit()
}

async function closeThread() {
  const id = threads.activeThreadId.value
  // Read the thread column's width BEFORE closeActiveThread() unmounts it.
  const threadW = threadPanelOpen.value ? sidePanelWidth('thread', 'thread') : 0
  threads.closeActiveThread()
  let reexpandW = 0
  if (utilityAutoCollapsedForThread.value) {
    utilityAutoCollapsedForThread.value = false
    if (rightPanelCollapsed.value) {
      reexpandW = sidePanelWidth('right-panel', 'utility')
      rightPanelCollapsed.value = false
      rightPanelRef.value?.expand()
    }
  }
  // Lose the thread column, regain any utility column we auto-collapsed — the
  // net shrink returns the window to its pre-thread size and drops the native
  // minimum back so it can shrink freely again.
  await resizeWindow(reexpandW - threadW, windowMinFor({ thread: false }))
  // An empty draft (opened, never sent) is disposable; a real thread persists.
  if (id) threads.deleteDraftIfEmpty(id)
}

/**
 * The write-back card lands via a plain RPC (thread.sendSummaryToMain), not a
 * turn — main's own useChat instance never sees it as a chunk, so reload its
 * transcript so the confirmed card actually shows up live.
 */
async function handleThreadSummarySent() {
  await chat.loadTranscript()
  nextTick(scrollToBottom)
}

/** Boot restore — adapts to whatever the window currently is; never grows it. */
async function restoreLastThreadIfAny() {
  const id = threads.lastActiveThreadId()
  if (!id) return
  threadAutoFocus.value = false
  const thread = await threads.openThreadById(id)
  if (!thread) {
    // Anchor (and therefore the thread) is gone — nothing to restore.
    threads.closeActiveThread()
    threadAutoFocus.value = true
    return
  }
  // The thread restores as a column. If the current window is too narrow to
  // also fit the utility panel, collapse it (boot never grows the window).
  if (rightPanelOpen.value && window.innerWidth < windowMinWidthForPanels({ thread: true, utility: true })) {
    utilityAutoCollapsedForThread.value = true
    rightPanelCollapsed.value = true
    rightPanelRef.value?.collapse()
  }
  await nextTick()
  // Match the native minimum to the restored layout — clamped to the current
  // width so boot never grows the window, only lets it shrink appropriately.
  await resizeWindow(0, Math.min(windowMinFor(), Math.round(window.innerWidth)))
  threadAutoFocus.value = true
}


const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { isAtBottom, scrollToBottom } = useAutoScroll(scrollEl)

chat.onQueryEnd(() => {
  refreshLibraryCount()
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
  window.addEventListener('bond:scroll-to-message', handleScrollToMessage)
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
    await chat.reconcileOnReconnect()
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
  refreshLibraryCount()
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
  // Match the native window minimum to whatever panels are open at boot so a
  // chat-only window can shrink small. Clamped to the current width so it only
  // lowers the floor, never forces the window to grow. restoreLastThreadIfAny
  // re-runs this with the thread-aware minimum when a thread is restored.
  void resizeWindow(0, Math.min(windowMinFor(), Math.round(window.innerWidth)))
  if (!sandboxed.value) void restoreLastThreadIfAny()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('bond:show-panel', handleShowPanel)
  window.removeEventListener('bond:scroll-to-message', handleScrollToMessage)
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
  <BondPanelGroup ref="panelGroupRef" direction="horizontal" autoSaveId="app-layout" style="width: 100%; height: 100vh;">
    <BondPanel id="main" :defaultSize="80" :minSize="30" :minSizePx="CHAT_MIN_WIDTH">
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
              :id="`msg-${msg.id}`"
              :key="msg.id"
              :msg="msg"
              @approve="chat.respondToApproval"
              @openThread="openThread"
            />
          </template>
        </div>

        <template #footer>
          <div class="chat-content-wrap px-3 relative">
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
                :context="approvalContext()"
                @respond="chat.respondToApproval"
              />
            </div>
            <div v-if="chat.pendingQuestion.value" class="approval-stack">
              <QuestionPrompt
                :questionId="chat.pendingQuestion.value.questionId"
                :question="chat.pendingQuestion.value.question"
                :header="chat.pendingQuestion.value.header"
                :options="chat.pendingQuestion.value.options"
                @answer="chat.answerQuestion"
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

    <template v-if="threadPanelOpen">
      <BondPanelHandle id="main-thread" beforePanelId="main" afterPanelId="thread" />
      <BondPanel
        id="thread"
        unit="px"
        :defaultSize="360"
        :minSize="320"
        :maxSize="99999"
        class="thread-panel"
        :class="{ 'thread-panel--rightmost': rightPanelHidden }"
      >
        <ThreadPanel
          :key="threads.activeThreadId.value ?? undefined"
          :threadId="threads.activeThreadId.value!"
          :model="selectedModel"
          :autoFocus="threadAutoFocus"
          @close="closeThread"
          @update:model="handleModelChange"
          @summarySent="handleThreadSummarySent"
        />
      </BondPanel>
    </template>

    <BondPanelHandle
      v-show="!rightPanelHidden"
      :id="threadPanelOpen ? 'thread-right' : 'main-right'"
      :beforePanelId="threadPanelOpen ? 'thread' : 'main'"
      afterPanelId="right-panel"
    />

    <BondPanel ref="rightPanelRef" id="right-panel" class="right-panel" unit="px" :defaultSize="320" :minSize="['sense', 'memory'].includes(rightPanelContent) ? 300 : 260" :maxSize="99999" collapsible :collapsedSize="0" :startCollapsed="rightPanelCollapsed">
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
      <DeskView v-else-if="rightPanelContent === 'desk'" />
      <LibraryView v-else-if="rightPanelContent === 'library'" />
      <ThreadsView v-else-if="rightPanelContent === 'threads'" @open="openThreadFromList" />
    </BondPanel>
  </BondPanelGroup>

  <!-- Threads first (it belongs to the conversation), then the onboarding
       tour order: Sense, Library, Memory, Collections. -->
  <nav class="right-panel-controls no-drag" aria-label="Panel views">
    <BondButton
      variant="ghost"
      size="sm"
      icon
      :aria-label="rightPanelOpen && rightPanelContent === 'threads' ? 'Close Threads panel' : 'Open Threads panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'threads' }"
      @click.stop="toggleRightPanel('threads')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'threads' ? 'Close Threads' : 'Threads'"
    >
      <PhChatCircleText :size="16" weight="bold" />
    </BondButton>
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
      :aria-label="rightPanelOpen && rightPanelContent === 'library' ? 'Close Library panel' : 'Open Library panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'library' }"
      @click.stop="toggleRightPanel('library')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'library' ? 'Close Library' : `Library${libraryCount ? ` (${libraryCount})` : ''}`"
    >
      <PhBooks :size="16" weight="bold" />
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
    <BondButton
      variant="ghost"
      size="sm"
      icon
      :aria-label="rightPanelOpen && rightPanelContent === 'desk' ? 'Close Desk panel' : 'Open Desk panel'"
      :class="{ 'panel-toggle-active': rightPanelOpen && rightPanelContent === 'desk' }"
      @click.stop="toggleRightPanel('desk')"
      v-tooltip="rightPanelOpen && rightPanelContent === 'desk' ? 'Close Desk' : 'Desk'"
    >
      <PhCompassRose :size="16" weight="bold" />
    </BondButton>
  </nav>

  <FieldManual :open="fieldManualOpen" @close="fieldManualOpen = false" />
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

/* Same seam every right-panel view draws for itself (border-left on its
   root) — the thread panel's ViewShell has none, so the main/thread edge
   was invisible without this. */
.thread-panel {
  border-left: 1px solid var(--color-border);
}

/* When the utility panel is collapsed the thread panel is the rightmost
   surface, and its toolbar-end actions would sit underneath the fixed
   .right-panel-controls nav — same clearance the utility panel gets. */
.thread-panel--rightmost .bond-toolbar__end {
  margin-right: var(--panel-controls-clearance);
}

/* Toolbar-end content in the rightmost panel clears the fixed nav below:
   6 sm icon buttons (26px) + 5 gaps (4px) = 176px, minus the toolbar's own
   0.75rem inline padding already offsetting the content. */
:root {
  --panel-controls-clearance: 11rem;
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
  margin-right: var(--panel-controls-clearance);
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
