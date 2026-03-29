<script setup lang="ts">
import type { Message } from '../types/message'
import MarkdownMessage from './MarkdownMessage.vue'

defineProps<{ msg: Message }>()
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
    class="self-start max-w-[92%] px-3.5 py-2.5 rounded-[10px] text-sm leading-relaxed bg-surface border border-border"
  />

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
