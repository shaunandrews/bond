<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useThreadConversation } from '../composables/useChat'
import { useThreads } from '../composables/useThreads'
import { useAutoScroll } from '../composables/useAutoScroll'
import type { Message, ModelId, AttachedImage } from '../types/message'
import type { EditMode } from '../../shared/session'
import type { ChatThread } from '../../shared/threads'
import ViewShell from './ViewShell.vue'
import MessageBubble from './MessageBubble.vue'
import ChatInput from './ChatInput.vue'
import ApprovalPrompt from './ApprovalPrompt.vue'
import QuestionPrompt from './QuestionPrompt.vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import BondTextarea from './BondTextarea.vue'
import { PhArrowDown, PhArrowSquareOut, PhClockCounterClockwise, PhDotsThree, PhPaperPlaneTilt, PhX } from '@phosphor-icons/vue'

const props = withDefaults(defineProps<{
  threadId: string
  model: ModelId
  /** False only when restoring the last-open thread on launch — never steal focus then. */
  autoFocus?: boolean
  /** True below the three/two-panel width threshold, where the thread replaces main as a full-height drawer. */
  drawer?: boolean
}>(), { autoFocus: true, drawer: false })

const emit = defineEmits<{
  close: []
  'update:model': [value: ModelId]
  /** The confirmed summary card landed in main — App.vue reloads main's transcript to show it live. */
  summarySent: []
}>()

// Fresh instance per thread — App.vue keys this component by threadId, so a
// switch between threads always remounts rather than reusing state.
const threadChat = useThreadConversation(props.threadId)
const threads = useThreads()

const thread = ref<ChatThread | null>(null)
async function loadThread() {
  thread.value = await window.bond.getThread(props.threadId)
}

// The root card renders from the thread's OWN frozen snapshot — the anchor's
// full text was captured at creation, so there's no need to depend on the
// main transcript still having it loaded.
const rootMessage = computed<Message | null>(() => {
  const snap = thread.value?.contextSnapshot
  if (!snap?.messages.length) return null
  const last = snap.messages[snap.messages.length - 1]
  return { id: last.id, role: 'bond', text: last.text, streaming: false }
})

const rootExpanded = ref(false)
const rootOverflowing = ref(false)
const rootContentEl = ref<HTMLElement | null>(null)

function checkRootOverflow() {
  const el = rootContentEl.value
  if (!el) return
  rootOverflowing.value = !rootExpanded.value && el.scrollHeight > el.clientHeight + 4
}

/** The snapshot is frozen at creation but the thread can be reopened much
 *  later — this marker is what stops isolation from reading as freshness. */
const contextAsOf = computed(() => {
  if (!thread.value) return ''
  const d = new Date(thread.value.contextSnapshot.createdAt)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `context as of ${time}`
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `context as of ${date}, ${time}`
})

const chatShellRef = ref<InstanceType<typeof ViewShell> | null>(null)
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const scrollEl = computed(() => chatShellRef.value?.scrollAreaEl ?? null)
const { isAtBottom, scrollToBottom } = useAutoScroll(scrollEl)

const draftKey = computed(() => `bond:thread-draft:${props.threadId}`)

function saveDraft() {
  try {
    const text = chatInputRef.value?.getText() ?? ''
    if (text) localStorage.setItem(draftKey.value, text)
    else localStorage.removeItem(draftKey.value)
  } catch { /* best effort */ }
}

function restoreDraft() {
  try {
    const saved = localStorage.getItem(draftKey.value)
    if (saved) chatInputRef.value?.setText(saved)
  } catch { /* best effort */ }
}

const recentOpen = ref(false)
const recentAnchorEl = ref<HTMLElement | null>(null)

function toggleRecent() {
  if (!recentOpen.value) void threads.loadRecent()
  recentOpen.value = !recentOpen.value
}

async function selectRecent(threadId: string) {
  recentOpen.value = false
  if (threadId === props.threadId) return
  saveDraft()
  await threads.openThreadById(threadId)
}

function showRootInConversation() {
  if (!rootMessage.value) return
  window.dispatchEvent(new CustomEvent('bond:scroll-to-message', { detail: rootMessage.value.id }))
}

// --- Write-back: "Send summary to main" (plans/chat-threads.md Phase 5b) ---
// Never automatic — the overflow action starts it, an editable confirmation
// sheet is the only way it actually reaches main.
const overflowOpen = ref(false)
const overflowAnchorEl = ref<HTMLElement | null>(null)
const summarySheet = ref<{ text: string; loading: boolean } | null>(null)
const sendingSummary = ref(false)
const summaryError = ref(false)

function toggleOverflow() {
  overflowOpen.value = !overflowOpen.value
}

async function startSendSummary() {
  overflowOpen.value = false
  summaryError.value = false
  summarySheet.value = { text: '', loading: true }
  try {
    const { summary } = await window.bond.summarizeThread(props.threadId)
    if (summarySheet.value) summarySheet.value = { text: summary, loading: false }
  } catch {
    if (summarySheet.value) { summarySheet.value.loading = false }
    summaryError.value = true
  }
}

function cancelSummarySheet() {
  summarySheet.value = null
  summaryError.value = false
}

async function confirmSendSummary() {
  const text = summarySheet.value?.text.trim()
  if (!text || sendingSummary.value) return
  sendingSummary.value = true
  summaryError.value = false
  try {
    await window.bond.sendThreadSummaryToMain(props.threadId, text)
    summarySheet.value = null
    emit('summarySent')
  } catch {
    summaryError.value = true
  } finally {
    sendingSummary.value = false
  }
}

async function handleSubmit(text: string, images: AttachedImage[]) {
  localStorage.removeItem(draftKey.value)
  nextTick(scrollToBottom)
  await threadChat.submit(text, images?.length ? images : undefined)
}

function handleCancel() {
  threadChat.cancel()
}

function handleModelChange(model: ModelId) {
  emit('update:model', model)
}

function handleEditModeChange(mode: EditMode) {
  threadChat.setEditMode(mode)
  window.bond.setEditMode(mode)
}

function handleClose() {
  saveDraft()
  emit('close')
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  if (threadChat.busy.value) threadChat.cancel()
  else handleClose()
}

onMounted(async () => {
  await loadThread()
  threadChat.subscribe()
  await threadChat.init()
  restoreDraft()
  if (props.autoFocus) nextTick(() => chatInputRef.value?.focus())
  nextTick(checkRootOverflow)
})

onUnmounted(() => {
  threadChat.unsubscribe()
})

defineExpose({ focusComposer: () => chatInputRef.value?.focus() })
</script>

<template>
  <ViewShell ref="chatShellRef" title="Thread" tabindex="-1" @keydown="handleKeydown">
    <template #header-start>
      <BondButton variant="ghost" size="sm" icon :aria-label="drawer ? 'Back to conversation' : 'Close thread'" v-tooltip="drawer ? 'Back' : 'Close'" @click="handleClose">
        <PhX :size="16" />
      </BondButton>
    </template>
    <template #header-end>
      <div ref="recentAnchorEl">
        <BondButton variant="ghost" size="sm" icon aria-label="Recent threads" v-tooltip="'Recent threads'" @click="toggleRecent">
          <PhClockCounterClockwise :size="16" />
        </BondButton>
      </div>
      <BondFlyoutMenu :open="recentOpen" :anchor="recentAnchorEl" placement="bottom-end" padding @close="recentOpen = false">
        <BondText v-if="!threads.recentThreads.value.length" as="div" size="xs" color="muted" class="recent-thread-empty">No threads yet</BondText>
        <button
          v-for="t in threads.recentThreads.value"
          :key="t.id"
          type="button"
          class="recent-thread-row"
          :class="{ 'recent-thread-row--active': t.id === threadId }"
          @click="selectRecent(t.id)"
        >
          <BondText size="sm" truncate class="flex-1 min-w-0">{{ t.title || 'Thread' }}</BondText>
          <BondText size="xs" color="muted">{{ t.replyCount }}</BondText>
        </button>
      </BondFlyoutMenu>

      <div ref="overflowAnchorEl">
        <BondButton variant="ghost" size="sm" icon aria-label="Thread options" v-tooltip="'More'" @click="toggleOverflow">
          <PhDotsThree :size="18" />
        </BondButton>
      </div>
      <BondFlyoutMenu :open="overflowOpen" :anchor="overflowAnchorEl" placement="bottom-end" padding @close="overflowOpen = false">
        <button type="button" class="overflow-menu-item" @click="startSendSummary">
          <PhPaperPlaneTilt :size="14" />
          Send summary to main
        </button>
      </BondFlyoutMenu>
    </template>

    <div class="thread-content-wrap px-4 pb-8 flex flex-col gap-2.5 flex-1">
      <div v-if="rootMessage" class="thread-root-card">
        <div class="thread-root-label">
          <BondText size="xs" color="muted">From the main conversation</BondText>
          <button type="button" class="thread-root-show-in" @click="showRootInConversation">
            <PhArrowSquareOut :size="11" />
            Show in conversation
          </button>
        </div>
        <div ref="rootContentEl" class="thread-root-content" :class="{ 'thread-root-content--clamped': rootOverflowing }">
          <MessageBubble :msg="rootMessage" />
        </div>
        <button v-if="rootOverflowing || rootExpanded" type="button" class="thread-root-expand" @click="rootExpanded = !rootExpanded; nextTick(checkRootOverflow)">
          {{ rootExpanded ? 'Show less' : 'Show full response' }}
        </button>
        <BondText size="xs" color="muted" class="thread-context-marker">{{ contextAsOf }}</BondText>
      </div>

      <MessageBubble
        v-for="msg in threadChat.messages.value"
        :id="`thread-msg-${msg.id}`"
        :key="msg.id"
        :msg="msg"
        @approve="threadChat.respondToApproval"
      />
    </div>

    <template #footer>
      <div class="thread-content-wrap px-3 relative">
        <Transition name="scroll-btn">
          <div v-if="!isAtBottom" class="scroll-to-bottom-wrap" @click="scrollToBottom">
            <BondButton variant="ghost" size="sm">
              <PhArrowDown :size="14" />
              <BondText size="xs" color="inherit">Bottom</BondText>
            </BondButton>
          </div>
        </Transition>
        <div v-if="threadChat.pendingApprovals.value.length" class="approval-stack">
          <ApprovalPrompt
            v-for="approval in threadChat.pendingApprovals.value"
            :key="approval.requestId"
            :requestId="approval.requestId"
            :toolName="approval.toolName"
            :input="approval.input"
            :description="approval.description"
            @respond="threadChat.respondToApproval"
          />
        </div>
        <div v-if="threadChat.pendingQuestion.value" class="approval-stack">
          <QuestionPrompt
            :questionId="threadChat.pendingQuestion.value.questionId"
            :question="threadChat.pendingQuestion.value.question"
            :header="threadChat.pendingQuestion.value.header"
            :options="threadChat.pendingQuestion.value.options"
            @answer="threadChat.answerQuestion"
          />
        </div>
        <ChatInput
          ref="chatInputRef"
          :busy="threadChat.busy.value"
          :model="model"
          :editMode="threadChat.editMode.value"
          :contextUsage="threadChat.contextUsage.value"
          placeholder="Discuss this response…"
          @submit="handleSubmit"
          @cancel="handleCancel"
          @update:model="handleModelChange"
          @update:editMode="handleEditModeChange"
        />
      </div>
    </template>
  </ViewShell>

  <Teleport to="body">
    <div v-if="summarySheet" class="summary-sheet-backdrop" role="dialog" aria-modal="true" aria-label="Send thread summary to main" @click.self="cancelSummarySheet">
      <div class="summary-sheet">
        <BondText as="h2" size="sm" weight="semibold">Send summary to main</BondText>
        <BondText size="xs" color="muted">
          A short summary of this thread, inserted as a visible card in the main conversation. Nothing else from this thread is shared.
        </BondText>
        <BondText v-if="summarySheet.loading" size="sm" color="muted" class="summary-sheet-loading">Summarizing…</BondText>
        <BondTextarea
          v-else
          :modelValue="summarySheet.text"
          :rows="5"
          placeholder="Summary…"
          @update:modelValue="(v) => { if (summarySheet) summarySheet.text = v }"
        />
        <BondText v-if="summaryError" size="xs" color="err">Something went wrong. You can try again.</BondText>
        <div class="summary-sheet-actions">
          <BondButton variant="secondary" size="sm" @click="cancelSummarySheet">Cancel</BondButton>
          <BondButton
            variant="primary"
            size="sm"
            :disabled="summarySheet.loading || !summarySheet.text.trim() || sendingSummary"
            @click="confirmSendSummary"
          >
            {{ sendingSummary ? 'Sending…' : 'Send to main' }}
          </BondButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.thread-content-wrap {
  max-width: 100%;
}

.thread-root-card {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-top: 0.5rem;
  padding: 0.625rem 0.75rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}

.thread-root-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.thread-root-show-in {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--color-muted);
  font-size: 0.6875rem;
  cursor: pointer;
  transition: color var(--transition-fast);
}

.thread-root-show-in:hover {
  color: var(--color-accent);
}

.thread-root-content {
  font-size: 0.8125rem;
}

.thread-root-content--clamped {
  max-height: 220px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 75%, transparent 100%);
}

.thread-root-expand {
  align-self: flex-start;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--color-accent);
  font-size: 0.6875rem;
  font-weight: 500;
  cursor: pointer;
}

.thread-context-marker {
  opacity: 0.7;
}

.recent-thread-empty {
  padding: 0.375rem 0.5rem;
}

.recent-thread-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast);
}

.recent-thread-row:hover {
  background: var(--color-bg);
}

.recent-thread-row--active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.overflow-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background var(--transition-fast);
}

.overflow-menu-item:hover {
  background: var(--color-bg);
}

.summary-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
}

.summary-sheet {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  width: min(420px, 92vw);
  padding: 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.summary-sheet-loading {
  padding: 1.5rem 0;
  text-align: center;
}

.summary-sheet-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.scroll-to-bottom-wrap {
  position: absolute;
  top: -2.75rem;
  left: 50%;
  transform: translateX(-50%);
  cursor: pointer;
}

.approval-stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition: opacity var(--transition-base), transform var(--transition-base);
}
.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}
</style>
