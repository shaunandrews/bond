<script setup lang="ts">
import { ref } from 'vue'
import { PhCaretRight } from '@phosphor-icons/vue'
import type { Message } from '../types/message'
import { imageDataUri } from '../../shared/session'
import MarkdownMessage from './MarkdownMessage.vue'

defineProps<{ msg: Message }>()
defineEmits<{ approve: [requestId: string, approved: boolean] }>()

const thinkingExpanded = ref(false)
const toast = ref<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
let toastTimer: ReturnType<typeof setTimeout> | undefined

function copyText(msg: Message, event: MouseEvent) {
  let text = ''
  if (msg.role === 'user') text = msg.text
  else if (msg.role === 'bond') text = msg.text
  else if (msg.kind === 'thinking') text = msg.text ?? ''
  else if (msg.kind === 'error' || msg.kind === 'system') text = msg.text
  else return
  if (!text) return
  navigator.clipboard.writeText(text)
  window.getSelection()?.removeAllRanges()
  clearTimeout(toastTimer)
  toast.value = { x: event.clientX, y: event.clientY - 8, visible: true }
  toastTimer = setTimeout(() => { toast.value.visible = false }, 1200)
}

function formatApprovalInput(input: Record<string, unknown>): string {
  const filePath = input.file_path ?? input.path
  if (typeof filePath === 'string') {
    const command = input.command
    if (typeof command === 'string') return command
    return filePath
  }
  if (typeof input.command === 'string') return input.command
  return JSON.stringify(input, null, 2).slice(0, 300)
}

function formatDuration(sec: number | undefined): string {
  if (sec == null || sec < 1) return 'briefly'
  if (sec < 60) return `for ${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `for ${m}m ${s}s` : `for ${m}m`
}

function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <!-- User message -->
  <div v-if="msg.role === 'user'" class="self-end max-w-[92%] flex flex-col items-end gap-1.5" @dblclick="copyText(msg, $event)">
    <div v-if="msg.images?.length" class="flex flex-wrap justify-end gap-1.5">
      <img
        v-for="(img, i) in msg.images"
        :key="i"
        :src="imageDataUri(img)"
        class="rounded-lg max-w-[200px] max-h-[200px] object-cover"
      />
    </div>
    <div v-if="msg.text" class="px-3.5 py-2.5 rounded-[10px] text-sm leading-relaxed bg-surface border border-border whitespace-pre-wrap">
      {{ msg.text }}
    </div>
    <span v-if="msg.ts" class="msg-timestamp">{{ formatTime(msg.ts) }}</span>
  </div>

  <!-- Bond message -->
  <MarkdownMessage
    v-else-if="msg.role === 'bond'"
    :text="msg.text"
    :streaming="msg.streaming"
    class="self-start w-full px-3.5 py-2.5 text-sm leading-relaxed"
    @dblclick="copyText(msg, $event)"
  />

  <!-- Tool approval -->
  <div
    v-else-if="msg.kind === 'approval'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs border"
    :class="msg.status === 'pending' ? 'border-accent' : 'border-dashed border-border'"
  >
    <div class="flex items-center gap-1.5">
      <span class="text-accent font-medium">{{ msg.toolName }}</span>
      <span v-if="msg.description" class="text-muted"> — {{ msg.description }}</span>
    </div>
    <pre class="mt-1.5 text-[11px] text-muted bg-surface rounded px-2 py-1 overflow-x-auto max-h-32 font-mono">{{ formatApprovalInput(msg.input) }}</pre>
    <div v-if="msg.status === 'pending'" class="flex gap-2 mt-2">
      <button
        class="px-2.5 py-1 rounded text-xs font-medium bg-accent text-white cursor-pointer hover:opacity-90 transition-opacity"
        @click="$emit('approve', msg.requestId, true)"
      >Allow</button>
      <button
        class="px-2.5 py-1 rounded text-xs font-medium border border-border text-muted cursor-pointer hover:bg-surface transition-colors"
        @click="$emit('approve', msg.requestId, false)"
      >Deny</button>
    </div>
    <div v-else class="mt-1.5 text-[11px] font-medium" :class="msg.status === 'approved' ? 'text-ok' : 'text-err'">
      {{ msg.status === 'approved' ? 'Allowed' : 'Denied' }}
    </div>
  </div>

  <!-- Thinking: single element transitions Working → Thinking → Thought -->
  <div
    v-else-if="msg.kind === 'thinking'"
    class="self-start w-full text-xs text-muted"
    @dblclick="copyText(msg, $event)"
  >
    <!-- Working (no text yet) or Thinking (text streaming) -->
    <div v-if="msg.streaming" class="px-1 py-1 italic opacity-70">
      <template v-if="msg.text">Thinking<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></template>
      <template v-else>Bond is working<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></template>
    </div>
    <!-- Thought: collapsed accordion -->
    <template v-else>
      <button
        class="flex items-center gap-1 px-1 py-1 text-left cursor-pointer opacity-70 hover:opacity-100 transition-opacity"
        @click="thinkingExpanded = !thinkingExpanded"
      >
        <span>Thought {{ formatDuration(msg.durationSec) }}</span>
        <PhCaretRight
          :size="10"
          weight="bold"
          class="thinking-chevron"
          :class="{ 'rotate-90': thinkingExpanded }"
        />
      </button>
      <div v-if="thinkingExpanded" class="px-1 pb-1">
        <pre class="thinking-content text-[11px] text-muted whitespace-pre-wrap font-sans leading-relaxed">{{ msg.text }}</pre>
      </div>
    </template>
  </div>

  <!-- Skill invocation -->
  <div
    v-else-if="msg.kind === 'skill'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-accent/40"
  >
    <span class="text-accent font-medium">/{{ msg.name }}</span>
    <span v-if="msg.args"> — {{ msg.args }}</span>
  </div>

  <!-- Tool call -->
  <div
    v-else-if="msg.kind === 'tool'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
  >
    <span class="text-accent font-medium">{{ msg.name }}</span>
    <span v-if="msg.summary"> — {{ msg.summary }}</span>
    <span v-if="msg.ts" class="msg-timestamp-inline">{{ formatTime(msg.ts) }}</span>
  </div>

  <!-- Error -->
  <div
    v-else-if="msg.kind === 'error'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-err border border-dashed border-border"
    @dblclick="copyText(msg, $event)"
  >
    {{ msg.text }}
  </div>

  <!-- System / other meta -->
  <div
    v-else
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
    @dblclick="copyText(msg, $event)"
  >
    {{ msg.text }}
  </div>
  <Teleport to="body">
    <Transition name="copy-toast">
      <div v-if="toast.visible" class="copy-toast" :style="{ left: toast.x + 'px', top: toast.y + 'px' }">
        Message copied
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.thinking-chevron {
  transition: transform var(--transition-fast);
}

.thinking-content {
  max-height: 300px;
  overflow-y: auto;
}

.thinking-dots span {
  animation: blink 1.4s infinite both;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}

.msg-timestamp {
  font-size: 0.625rem;
  color: var(--color-muted);
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.msg-timestamp-inline {
  font-size: 0.625rem;
  color: var(--color-muted);
  opacity: 0.5;
  margin-left: 0.5rem;
  font-variant-numeric: tabular-nums;
}

.copy-toast {
  position: fixed;
  transform: translate(-50%, -100%);
  padding: 4px 10px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-md);
  font-size: 11px;
  color: var(--color-muted);
  pointer-events: none;
  z-index: 9999;
  white-space: nowrap;
}

.copy-toast-enter-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.copy-toast-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.copy-toast-enter-from {
  opacity: 0;
  transform: translate(-50%, -80%);
}
.copy-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -120%);
}
</style>
