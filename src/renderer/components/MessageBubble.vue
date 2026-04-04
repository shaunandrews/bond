<script setup lang="ts">
import { ref, computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Message } from '../types/message'
import { imageDataUri } from '../../shared/session'
import MarkdownMessage from './MarkdownMessage.vue'
import ArtifactFrame from './ArtifactFrame.vue'
import EmbedRenderer from './EmbedRenderer.vue'
import { parseArtifacts, hasRichContent } from '../lib/parseArtifacts'

function renderUserMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(raw)
}

const props = defineProps<{ msg: Message }>()
defineEmits<{
  approve: [requestId: string, approved: boolean]
  openActivity: []
}>()

const segments = computed(() => {
  if (props.msg.role !== 'bond' || !hasRichContent(props.msg.text)) return null
  return parseArtifacts(props.msg.text)
})

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

function formatToolSummary(name: string, summary?: string): string {
  const filename = summary?.split('/').pop() || summary
  const verbs: Record<string, string> = {
    Read: 'Read', Edit: 'Edited', Write: 'Wrote',
    Bash: 'Ran command', Glob: 'Searched files', Grep: 'Searched code',
    WebSearch: 'Searched the web', WebFetch: 'Fetched page',
  }
  const verb = verbs[name] ?? name
  return filename && !['Bash', 'Glob', 'WebSearch'].includes(name) ? `${verb} ${filename}` : verb
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
    <div
      v-if="msg.text"
      class="user-markdown px-3.5 py-2.5 rounded-[10px] leading-relaxed bg-surface shadow-sm"
      v-html="renderUserMarkdown(msg.text)"
    />
    <span v-if="msg.ts" class="msg-timestamp">{{ formatTime(msg.ts) }}</span>
  </div>

  <!-- Bond message: with artifacts -->
  <div
    v-else-if="msg.role === 'bond' && segments"
    class="self-start w-full text-sm leading-relaxed"
    @dblclick="copyText(msg, $event)"
  >
    <template v-for="(seg, i) in segments" :key="i">
      <MarkdownMessage
        v-if="seg.type === 'text' && seg.content.trim()"
        :text="seg.content"
        :streaming="msg.streaming && i === segments.length - 1"
        class="px-3.5 py-2.5"
      />
      <ArtifactFrame
        v-else-if="seg.type === 'artifact'"
        :content="seg.content"
        :title="seg.title"
        :layout="seg.layout"
        :chrome="seg.chrome"
        :streaming="msg.streaming"
      />
      <EmbedRenderer
        v-else-if="seg.type === 'embed'"
        :embedType="seg.embedType"
        :attrs="seg.attrs"
        class="px-3.5"
      />
    </template>
  </div>

  <!-- Bond message: plain markdown -->
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

  <!-- Thinking: hidden while streaming (activity bar handles it), minimal summary when finalized -->
  <!-- Streaming thinking renders nothing — swallowed so it doesn't hit the v-else catch-all -->
  <template v-else-if="msg.kind === 'thinking' && (msg.streaming || !msg.text)" />
  <span
    v-else-if="msg.kind === 'thinking'"
    class="activity-summary"
    @click="$emit('openActivity')"
  >Thought {{ formatDuration(msg.durationSec) }}</span>

  <!-- Skill invocation -->
  <div
    v-else-if="msg.kind === 'skill'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-accent/40"
  >
    <span class="text-accent font-medium">/{{ msg.name }}</span>
    <span v-if="msg.args"> — {{ msg.args }}</span>
  </div>

  <!-- Tool call — minimal summary -->
  <span
    v-else-if="msg.kind === 'tool'"
    class="activity-summary"
    @click="$emit('openActivity')"
  >{{ formatToolSummary(msg.name, msg.summary) }}</span>

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
.activity-summary {
  display: block;
  text-align: center;
  font-size: 11px;
  color: var(--color-muted);
  opacity: 0.55;
  cursor: pointer;
  padding: 1px 0;
  transition: opacity var(--transition-fast);
}
.activity-summary:hover {
  opacity: 0.85;
}

.msg-timestamp {
  font-size: 0.625rem;
  color: var(--color-muted);
  opacity: 0.6;
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
  transition: opacity var(--transition-base), transform var(--transition-base);
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

/* User message markdown */
.user-markdown :deep(p) { margin: 0; }
.user-markdown :deep(p + p) { margin-top: 0.4em; }
.user-markdown :deep(p:only-child) { white-space: pre-wrap; }
.user-markdown :deep(strong) { font-weight: 600; }
.user-markdown :deep(em) { font-style: italic; }
.user-markdown :deep(del) { text-decoration: line-through; }
.user-markdown :deep(code) {
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
  font-size: 0.88em;
  font-family: var(--font-mono);
}
.user-markdown :deep(blockquote) {
  border-left: 3px solid var(--color-border);
  margin: 0.3em 0;
  padding-left: 0.7em;
  color: var(--color-muted);
}
.user-markdown :deep(ul), .user-markdown :deep(ol) {
  margin: 0.3em 0;
  padding-left: 1.4em;
}
.user-markdown :deep(li) { margin: 0.1em 0; }
.user-markdown :deep(a) { color: var(--color-accent); text-decoration: underline; }
</style>
