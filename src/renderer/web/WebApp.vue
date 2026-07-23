<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useChat } from '../composables/useChat'
import { useAutoScroll } from '../composables/useAutoScroll'
import { useAccentColor } from '../composables/useAccentColor'
import { useAgentRuns } from '../composables/useAgentRuns'
import type { ModelId } from '../types/message'
import type { EditMode, AttachedImage } from '../../shared/session'
import MessageBubble from '../components/MessageBubble.vue'
import ChatInput from '../components/ChatInput.vue'
import ApprovalPrompt from '../components/ApprovalPrompt.vue'
import QuestionPrompt from '../components/QuestionPrompt.vue'
import TasksView from '../components/TasksView.vue'
import BondText from '../components/BondText.vue'
import BondButton from '../components/BondButton.vue'
import { PhArrowDown, PhRobot, PhX } from '@phosphor-icons/vue'
import type { WebBondClient, ConnectionState, PairingError } from './client'
import { clearDeviceCredential, exchangePairingCode, isStandaloneDisplay } from './client'

const props = defineProps<{
  client: WebBondClient
  hasToken: boolean
}>()

const chat = useChat()
const accent = useAccentColor()
const agentRuns = useAgentRuns()
const mobileTasksOpen = ref(false)
const selectedModel = ref<ModelId>('balanced')
const connection = ref<ConnectionState>(props.client.state)
const hasConnected = ref(false)

const needsPairing = computed(() => !props.hasToken || connection.value === 'unpaired')

const composerPlaceholder = computed<string | undefined>(() =>
  chat.pendingQuestion.value ? 'Pick an option above, or type your own answer…' : undefined
)

// An installed Home Screen app can't be re-paired by opening a QR link — that
// would land in Safari, whose storage it can't see. It pairs with a code.
const isStandalone = isStandaloneDisplay()
const pairingCode = ref('')
const pairingBusy = ref(false)
const pairingError = ref<PairingError | null>(null)

const PAIRING_ERROR_TEXT: Record<PairingError, string> = {
  invalid: "That code didn't match. Check it and try again.",
  expired: 'That code expired. Generate a fresh one on your Mac.',
  used: 'That code was already used. Generate a fresh one on your Mac.',
  throttled: 'Too many attempts. Generate a fresh code on your Mac.',
  unavailable: "Bond's pairing service isn't available. Restart Bond on your Mac.",
  offline: "Can't reach Bond on your Mac. Check both devices are on the same Wi-Fi and Bond is running.",
}

async function submitPairingCode() {
  if (pairingBusy.value || !pairingCode.value.trim()) return
  pairingBusy.value = true
  pairingError.value = null
  const result = await exchangePairingCode(pairingCode.value.trim())
  if (result.ok) {
    // A rejected credential may still be sitting in the client; reloading is
    // the honest way to re-enter the normal boot path with the new one.
    window.location.reload()
    return
  }
  // A credential this daemon rejected is dead weight — drop it so the next
  // launch starts clean at the pairing screen instead of retrying it.
  if (connection.value === 'unpaired') clearDeviceCredential()
  pairingError.value = result.reason
  pairingBusy.value = false
}

const messagesRef = ref<HTMLElement | null>(null)
const inputAreaRef = ref<HTMLElement | null>(null)
const hasScrollableMessages = ref(false)
const { isAtBottom, scrollToBottom } = useAutoScroll(messagesRef)

let disposeState: (() => void) | undefined
let composerResizeObserver: ResizeObserver | undefined

function syncComposerHeight() {
  const height = inputAreaRef.value?.offsetHeight ?? 0
  document.documentElement.style.setProperty('--mobile-composer-height', `${height}px`)
}

function syncTranscriptOverflow() {
  const el = messagesRef.value
  hasScrollableMessages.value = !!el && el.scrollHeight > el.clientHeight + 1
}

function goToLatestMessage() {
  scrollToBottom()
  syncTranscriptOverflow()
}

onMounted(async () => {
  disposeState = props.client.onStateChange(async (state) => {
    connection.value = state
    if (state === 'connected') {
      if (hasConnected.value) {
        // Chunks streamed while the phone slept are gone. Reconcile before
        // reloading: a blind reload can leave local turn ownership/busy state
        // stranded after the daemon has already finalized the turn.
        await chat.reconcileOnReconnect().catch(() => {})
        await agentRuns.reconcile().catch(() => {})
        nextTick(() => scrollToBottom())
      }
      hasConnected.value = true
    }
  })

  if (needsPairing.value) return
  chat.subscribe()
  await chat.init().catch(() => {})
  if (props.client.state === 'connected') hasConnected.value = true
  nextTick(() => {
    syncComposerHeight()
    if (inputAreaRef.value && typeof ResizeObserver !== 'undefined') {
      composerResizeObserver = new ResizeObserver(syncComposerHeight)
      composerResizeObserver.observe(inputAreaRef.value)
    }
    scrollToBottom()
    syncTranscriptOverflow()
  })
  accent.load().catch(() => {})
  try {
    const model = await window.bond.getModel()
    if (model) selectedModel.value = model as ModelId
    const mode = await window.bond.getEditMode()
    if (mode) chat.setEditMode(mode)
  } catch { /* defaults are fine */ }
})

onUnmounted(() => {
  chat.unsubscribe()
  disposeState?.()
  composerResizeObserver?.disconnect()
  document.documentElement.style.removeProperty('--mobile-composer-height')
})

watch(() => chat.messages.value.length, () => {
  nextTick(() => {
    scrollToBottom()
    syncTranscriptOverflow()
  })
})

function handleSend(text: string, images: AttachedImage[]) {
  chat.submit(text, images)
  nextTick(() => scrollToBottom())
}

function handleModelChange(model: ModelId) {
  selectedModel.value = model
  window.bond.setModel(model)
}

function handleEditModeChange(mode: EditMode) {
  // Apply to this device's next turn AND persist globally — the daemon
  // broadcasts edit_mode_changed so every other client mirrors it.
  chat.setEditMode(mode)
  window.bond.setEditMode(mode)
}
</script>

<template>
  <div class="web-app">
    <div v-if="connection === 'mismatch'" class="pairing-screen">
      <BondText as="h1" size="xl" weight="semibold">Bond</BondText>
      <BondText as="p" color="muted" align="center">
        Bond on your Mac was updated and speaks a different protocol version.
        Restart Bond there, then reload this page.
      </BondText>
    </div>

    <div v-else-if="needsPairing && isStandalone" class="pairing-screen">
      <BondText as="h1" size="xl" weight="semibold">Pair this device</BondText>
      <BondText as="p" color="muted" align="center">
        On your Mac, open Bond → Settings → Remote access and tap
        <strong>Generate pairing code</strong>. Enter it here.
      </BondText>

      <form class="pairing-form" @submit.prevent="submitPairingCode">
        <input
          v-model="pairingCode"
          class="pairing-input"
          type="text"
          inputmode="text"
          autocapitalize="characters"
          autocorrect="off"
          spellcheck="false"
          autocomplete="one-time-code"
          maxlength="12"
          placeholder="ABCD1234"
          aria-label="Pairing code"
          :disabled="pairingBusy"
        />
        <BondButton type="submit" variant="primary" :disabled="pairingBusy || !pairingCode.trim()">
          {{ pairingBusy ? 'Pairing…' : 'Pair' }}
        </BondButton>
      </form>

      <BondText v-if="pairingError" as="p" size="sm" color="err" align="center">
        {{ PAIRING_ERROR_TEXT[pairingError] }}
      </BondText>
      <BondText as="p" size="xs" color="muted" align="center">
        Bond runs on your Mac. This app needs both devices on the same network.
      </BondText>
    </div>

    <div v-else-if="needsPairing" class="pairing-screen">
      <BondText as="h1" size="xl" weight="semibold">Bond</BondText>
      <BondText as="p" color="muted" align="center">
        This device isn't paired{{ connection === 'unpaired' ? ' anymore' : '' }}.
        Open Bond on your Mac, go to Settings → Remote access, and open the
        pairing link or scan the QR code from this device.
      </BondText>
      <BondText as="p" size="xs" color="muted" align="center">
        Want Bond on your Home Screen? Tap Share → Add to Home Screen, then
        pair it with a code from the same settings panel.
      </BondText>
    </div>

    <template v-else>
      <header v-if="connection !== 'connected' || agentRuns.activeRuns.value.length" class="web-header">
        <BondText size="xs" color="muted">
          {{ connection === 'connected' ? `${agentRuns.activeRuns.value.length} active background ${agentRuns.activeRuns.value.length === 1 ? 'task' : 'tasks'}` : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…' }}
        </BondText>
        <button v-if="agentRuns.activeRuns.value.length" class="web-agent-button" type="button" aria-label="Open background tasks" @click="mobileTasksOpen = true"><PhRobot :size="16" /></button>
      </header>

      <div v-if="mobileTasksOpen" class="web-tasks-drawer" role="dialog" aria-modal="true" aria-label="Background tasks">
        <button type="button" class="web-tasks-close" aria-label="Close background tasks" @click="mobileTasksOpen = false"><PhX :size="18" /></button>
        <TasksView />
      </div>

      <div ref="messagesRef" class="messages" @scroll="syncTranscriptOverflow">
        <div class="chat-column messages-column">
          <MessageBubble
            v-for="msg in chat.messages.value"
            :key="msg.id"
            :msg="msg"
            :threadsEnabled="false"
            @approve="chat.respondToApproval"
          />
        </div>
      </div>

      <button
        v-if="hasScrollableMessages && !isAtBottom"
        type="button"
        class="go-to-latest"
        aria-label="Go to latest message"
        title="Go to latest message"
        @click="goToLatestMessage"
      >
        <PhArrowDown :size="18" weight="bold" />
      </button>

      <!-- These sit above the scrolling transcript. Their masks make the blur
           dissolve rather than ending in two hard, frosted bands. -->
      <div class="transcript-fade transcript-fade--top" aria-hidden="true" />
      <div class="transcript-fade transcript-fade--bottom" aria-hidden="true" />

      <div ref="inputAreaRef" class="input-area">
        <div class="chat-column">
          <div v-if="chat.currentQueue.value.length" class="queued-list">
            <div v-for="msg in chat.currentQueue.value" :key="msg.id" class="queued-item">
              <BondText size="xs" color="muted" truncate class="flex-1 min-w-0">{{ msg.text }}</BondText>
              <button class="queued-dismiss" @click="chat.removeQueuedMessage(msg.id)">
                <PhX :size="10" />
              </button>
            </div>
          </div>
          <div v-if="chat.pendingApprovals.value.length" class="approval-stack">
            <ApprovalPrompt
              v-for="approval in chat.pendingApprovals.value"
              :key="approval.requestId"
              :requestId="approval.requestId"
              :toolName="approval.toolName"
              :input="approval.input"
              :description="approval.description"
              @respond="chat.respondToApproval"
            />
          </div>
          <div v-if="chat.pendingQuestion.value" class="question-stack">
            <QuestionPrompt
              :questionId="chat.pendingQuestion.value.questionId"
              :question="chat.pendingQuestion.value.question"
              :header="chat.pendingQuestion.value.header"
              :options="chat.pendingQuestion.value.options"
              @answer="chat.answerQuestion"
            />
          </div>
          <ChatInput
            mobile
            :busy="chat.busy.value"
            :model="selectedModel"
            :editMode="chat.editMode.value"
            :contextUsage="chat.contextUsage.value"
            :placeholder="composerPlaceholder"
            @submit="handleSend"
            @cancel="chat.cancel"
            @update:model="handleModelChange"
            @update:editMode="handleEditModeChange"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The document is never a scroll surface on mobile. Keeping the scroll chain
   inside .messages avoids iOS handing a gesture to the browser/app shell. */
:global(html),
:global(body),
:global(#app) {
  overflow: hidden;
  overscroll-behavior: none;
}

.web-app {
  display: flex;
  flex-direction: column;
  position: relative;
  /* dvh, not vh — mobile browser chrome overlaps 100vh layouts. */
  height: 100dvh;
  min-height: 0;
  /* clip, not hidden: `hidden` still makes this a scroll container, so an
     overflowing child stays scrollable programmatically — focusing a field
     near the edge slides the whole shell sideways. `clip` gives the shell no
     scroll box at all, so body can never receive scrollable overflow. */
  overflow: clip;
  background: var(--color-bg);
}

.pairing-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  max-width: 420px;
  margin-inline: auto;
}

.pairing-form {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-block: 4px;
}

.pairing-input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  /* 16px minimum, or iOS zooms the viewport when the field takes focus. */
  font-size: 16px;
  letter-spacing: 0.14em;
  text-align: center;
  text-transform: uppercase;
}

.pairing-input:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.web-header {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  min-height: var(--toolbar-height);
  padding: env(safe-area-inset-top) 16px 0;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Setting only overflow-y computes overflow-x to `auto`, not `visible` — so
     a single overflowing message (wide table, long URL, oversized image) made
     the entire transcript swipeable sideways. The transcript scrolls in one
     axis, always; anything too wide must scroll inside its own box. */
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}

.chat-column {
  width: 100%;
  max-width: 720px;
  min-width: 0;
  margin-inline: auto;
  padding-inline: 16px;
}

.messages-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* Keep the first turn clear of the status controls while still allowing the
     transcript to run underneath the top fade. */
  padding-top: max(16px, calc(env(safe-area-inset-top) + 16px));
  /* The input floats over this scroller. Its live height covers expanded
     text, attachment strips, queues, and approval prompts. */
  padding-bottom: calc(var(--mobile-composer-height, 112px) + 48px);
}

/* The authored turn is a single quiet surface. Bond replies deliberately
   remain full-width and unframed so longer responses read as prose. */
:deep(.message-bubble--user) {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  align-self: flex-end;
  width: fit-content;
  max-width: 84%;
}

:deep(.message-bubble--user .msg-timestamp) {
  align-self: flex-end;
  margin-top: var(--space-tight);
}

:deep(.message-bubble--user .user-markdown) {
  padding: var(--space-compact) var(--space-default);
  border-radius: var(--radius-xl);
  background: var(--color-message-user-bg);
  color: var(--color-message-user-text);
  box-shadow: none;
}

.transcript-fade {
  position: absolute;
  right: 0;
  left: 0;
  z-index: 2;
  height: 72px;
  pointer-events: none;
  backdrop-filter: blur(9px);
  -webkit-backdrop-filter: blur(9px);
}

.transcript-fade--top {
  top: 0;
  height: max(80px, calc(env(safe-area-inset-top) + 28px));
  /* iOS owns the status-bar pixels. Start from that exact black/white edge,
     then dissolve into the app rather than exposing a colour seam. */
  background: linear-gradient(to bottom, var(--mobile-system-edge), color-mix(in srgb, var(--color-bg) 70%, transparent) 46%, transparent);
  mask-image: linear-gradient(to bottom, black, transparent);
  -webkit-mask-image: linear-gradient(to bottom, black, transparent);
}

.transcript-fade--bottom {
  /* One continuous fade reaches the physical bottom of the viewport. The
     composer sits inside it rather than being wrapped by a frosted panel. */
  bottom: 0;
  height: calc(var(--mobile-composer-height, 112px) + 88px);
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--color-bg) 72%, transparent) 44%, var(--color-bg));
  mask-image: linear-gradient(to bottom, transparent, black 42%, black);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 42%, black);
}

.input-area {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 3;
  /* The mobile composer is a full-width bottom bar, not a floating card. */
  padding: 0;
  background: transparent;
  border: 0;
}

.input-area .chat-column {
  max-width: none;
  padding-inline: 0;
}

.go-to-latest {
  position: absolute;
  right: 16px;
  bottom: calc(var(--mobile-composer-height, 112px) + 16px);
  z-index: 4;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
  color: var(--color-text-primary);
  cursor: pointer;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.go-to-latest:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.queued-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.queued-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.queued-dismiss {
  display: flex;
  align-items: center;
  color: var(--color-muted);
  cursor: pointer;
}

.approval-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

/* A question is part of the composer flow, not a floating approval card.
   Keep it attached to the composer and let its option dividers run full width. */
.question-stack {
  margin: 0;
}

.web-header { display: flex; align-items: center; justify-content: space-between; }
.web-agent-button, .web-tasks-close { display: grid; place-items: center; border: 0; background: transparent; color: var(--color-muted); cursor: pointer; }
.web-agent-button { width: 36px; height: 36px; border-radius: 50%; background: var(--color-tint); }
.web-tasks-drawer { position: fixed; inset: 0; z-index: 30; background: var(--color-bg); padding-top: env(safe-area-inset-top); }
.web-tasks-close { position: absolute; z-index: 40; top: calc(env(safe-area-inset-top) + .45rem); right: .45rem; width: 32px; height: 32px; border-radius: var(--radius-md); }
.web-tasks-close:focus-visible, .web-agent-button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.web-tasks-drawer :deep(.tasks-panel) { border-left: 0; }
</style>
