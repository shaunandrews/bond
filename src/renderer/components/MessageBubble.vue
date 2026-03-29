<script setup lang="ts">
import type { Message } from '../types/message'
import MarkdownMessage from './MarkdownMessage.vue'

defineProps<{ msg: Message }>()
defineEmits<{ approve: [requestId: string, approved: boolean] }>()

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
</script>

<template>
  <!-- User message -->
  <div
    v-if="msg.role === 'user'"
    class="self-end max-w-[92%] px-3.5 py-2.5 rounded-[10px] text-sm leading-relaxed bg-surface border border-border whitespace-pre-wrap"
  >
    {{ msg.text }}
  </div>

  <!-- Bond message -->
  <MarkdownMessage
    v-else-if="msg.role === 'bond'"
    :text="msg.text"
    :streaming="msg.streaming"
    class="self-start w-full px-3.5 py-2.5 text-sm leading-relaxed"
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

  <!-- Tool call -->
  <div
    v-else-if="msg.kind === 'tool'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
  >
    <span class="text-accent font-medium">{{ msg.name }}</span>
    <span v-if="msg.summary"> — {{ msg.summary }}</span>
  </div>

  <!-- Error -->
  <div
    v-else-if="msg.kind === 'error'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-err border border-dashed border-border"
  >
    {{ msg.text }}
  </div>

  <!-- System / other meta -->
  <div
    v-else
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
  >
    {{ msg.text }}
  </div>
</template>
