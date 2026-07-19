<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useChat } from '../composables/useChat'
import { useAutoScroll } from '../composables/useAutoScroll'
import { useAccentColor } from '../composables/useAccentColor'
import type { ModelId } from '../types/message'
import type { EditMode, AttachedImage } from '../../shared/session'
import MessageBubble from '../components/MessageBubble.vue'
import ChatInput from '../components/ChatInput.vue'
import ApprovalPrompt from '../components/ApprovalPrompt.vue'
import BondText from '../components/BondText.vue'
import { PhX } from '@phosphor-icons/vue'
import type { WebBondClient, ConnectionState } from './client'

const props = defineProps<{
  client: WebBondClient
  hasToken: boolean
}>()

const chat = useChat()
const accent = useAccentColor()
const selectedModel = ref<ModelId>('balanced')
const connection = ref<ConnectionState>(props.client.state)
const hasConnected = ref(false)

const needsPairing = computed(() => !props.hasToken || connection.value === 'unpaired')

const messagesRef = ref<HTMLElement | null>(null)
const { scrollToBottom } = useAutoScroll(messagesRef)

let disposeState: (() => void) | undefined

onMounted(async () => {
  disposeState = props.client.onStateChange(async (state) => {
    connection.value = state
    if (state === 'connected') {
      if (hasConnected.value) {
        // Chunks streamed while the phone slept are gone — SQLite has the
        // canonical rows, so a reload catches the transcript up.
        await chat.loadTranscript().catch(() => {})
        nextTick(() => scrollToBottom())
      }
      hasConnected.value = true
    }
  })

  if (needsPairing.value) return
  chat.subscribe()
  await chat.init().catch(() => {})
  if (props.client.state === 'connected') hasConnected.value = true
  nextTick(() => scrollToBottom())
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
})

watch(() => chat.messages.value.length, () => {
  nextTick(() => scrollToBottom())
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

    <div v-else-if="needsPairing" class="pairing-screen">
      <BondText as="h1" size="xl" weight="semibold">Bond</BondText>
      <BondText as="p" color="muted" align="center">
        This device isn't paired{{ connection === 'unpaired' ? ' anymore' : '' }}.
        Open Bond on your Mac, go to Settings → Remote access, and open the
        pairing link or scan the QR code from this device.
      </BondText>
    </div>

    <template v-else>
      <header class="web-header">
        <BondText size="sm" weight="semibold">Bond</BondText>
        <BondText v-if="connection !== 'connected'" size="xs" color="muted" class="conn-banner">
          {{ connection === 'connecting' ? 'Connecting…' : 'Reconnecting…' }}
        </BondText>
      </header>

      <div ref="messagesRef" class="messages">
        <div class="chat-column messages-column">
          <MessageBubble
            v-for="msg in chat.messages.value"
            :key="msg.id"
            :msg="msg"
            @approve="chat.respondToApproval"
          />
        </div>
      </div>

      <div class="input-area">
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
          <ChatInput
            :busy="chat.busy.value"
            :model="selectedModel"
            :editMode="chat.editMode.value"
            :contextUsage="chat.contextUsage.value"
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
.web-app {
  display: flex;
  flex-direction: column;
  /* dvh, not vh — mobile browser chrome overlaps 100vh layouts. */
  height: 100dvh;
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

.web-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  height: var(--toolbar-height);
  padding-inline: 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 72%, transparent);
  padding-top: env(safe-area-inset-top);
  background: color-mix(in srgb, var(--color-bg) 72%, transparent);
  backdrop-filter: blur(20px) saturate(1.15);
  -webkit-backdrop-filter: blur(20px) saturate(1.15);
}

.conn-banner {
  animation: conn-pulse 1.6s ease-in-out infinite;
}

@keyframes conn-pulse {
  50% { opacity: 0.4; }
}

.messages {
  flex: 1;
  overflow-y: auto;
}

.chat-column {
  width: 100%;
  max-width: 720px;
  margin-inline: auto;
  padding-inline: 16px;
}

.messages-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-block: 16px 40px;
}

.input-area {
  flex-shrink: 0;
  padding-top: 10px;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--color-bg) 78%, transparent) 28%);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
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
</style>
