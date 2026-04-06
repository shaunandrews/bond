<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useChat } from '../composables/useChat'
import { useAutoScroll } from '../composables/useAutoScroll'
import type { ModelId } from '../types/message'
import type { EditMode } from '../../shared/session'
import MessageBubble from './MessageBubble.vue'
import ChatInput from './ChatInput.vue'

const chat = useChat()
const sessionId = ref<string | null>(null)
const senseApps = ref<string[]>([])
const selectedModel = ref<ModelId>('sonnet')
const editMode = ref<EditMode>({ type: 'full' })
const ready = ref(false)
const animateIn = ref(false)
const animateOut = ref(false)

const messagesRef = ref<HTMLElement | null>(null)
const { scrollToBottom } = useAutoScroll(messagesRef)

// Load model
onMounted(async () => {
  try {
    const model = await window.bond.getModel()
    if (model) selectedModel.value = model as ModelId
  } catch { /* use default */ }
})

// Listen for init data from main process
let cleanupInit: (() => void) | undefined
let cleanupDismiss: (() => void) | undefined

onMounted(() => {
  chat.subscribe()

  cleanupInit = window.bond.onQuickChatInit(async (data: { sessionId: string; senseApps: string[] }) => {
    sessionId.value = data.sessionId
    senseApps.value = data.senseApps
    chat.clearMessages()
    await chat.loadSession(data.sessionId)
    ready.value = true

    // Trigger entry animation
    await nextTick()
    requestAnimationFrame(() => {
      animateIn.value = true
    })
  })

  // Listen for dismiss signal from main process
  cleanupDismiss = window.bond.onQuickChatDismiss(() => {
    animateOut.value = true
    setTimeout(() => {
      window.bond.quickChatDismissed()
      animateOut.value = false
      animateIn.value = false
      ready.value = false
    }, 200)
  })
})

onUnmounted(() => {
  chat.unsubscribe()
  cleanupInit?.()
  cleanupDismiss?.()
})

// Auto-scroll when messages change
watch(() => chat.messages.value.length, () => {
  nextTick(() => scrollToBottom())
})

function handleSend(text: string) {
  chat.submit(text)
  nextTick(() => scrollToBottom())
}

function handleCancel() {
  chat.cancel()
}

function handleModelUpdate(model: ModelId) {
  selectedModel.value = model
  window.bond.setModel(model)
}

// Escape key: dismiss when not busy, cancel when busy
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (chat.busy.value) {
      // First Escape cancels the response (ChatInput handles this)
      return
    }
    // Dismiss the quick chat
    window.bond.quickChatDismissed()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    class="quick-chat"
    :class="{ 'animate-in': animateIn, 'animate-out': animateOut }"
  >
    <template v-if="ready">
      <!-- Context bar -->
      <div v-if="senseApps.length" class="context-bar">
        <span class="context-label">Watching: {{ senseApps.join(', ') }}</span>
        <span class="context-time">&mdash; last 5 min</span>
      </div>

      <!-- Messages -->
      <div ref="messagesRef" class="messages">
        <MessageBubble
          v-for="msg in chat.messages.value"
          :key="msg.id"
          :msg="msg"
          @approve="chat.respondToApproval"
        />
      </div>

      <!-- Input -->
      <div class="input-area">
        <ChatInput
          :busy="chat.busy.value"
          :model="selectedModel"
          :edit-mode="editMode"
          trim-bottom
          @submit="handleSend"
          @cancel="handleCancel"
          @update:model="handleModelUpdate"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.quick-chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: transparent;
  overflow: hidden;
  opacity: 0;
  transform: scale(0.97);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.quick-chat.animate-in {
  opacity: 1;
  transform: scale(1);
}

.quick-chat.animate-out {
  opacity: 0;
  transform: scale(0.97);
}

.context-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.context-label {
  opacity: 0.8;
}

.context-time {
  opacity: 0.5;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.messages::-webkit-scrollbar {
  width: 4px;
}

.messages::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
}

.input-area {
  flex-shrink: 0;
  padding: 0 8px 8px;
}

/* Override user message bubble backgrounds for vibrancy */
:deep(.message-bubble.user) {
  background: rgba(255, 255, 255, 0.08) !important;
}
</style>
