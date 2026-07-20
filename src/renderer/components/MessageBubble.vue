<script setup lang="ts">
import { ref, computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Message } from '../types/message'
import { imageDataUri, type AttachedImage } from '../../shared/session'
import { ISSUE_KEY_RE } from '../../shared/fields'
import { useIssueReferences } from '../composables/useIssueReferences'
import MarkdownMessage from './MarkdownMessage.vue'
import ArtifactFrame from './ArtifactFrame.vue'
import EmbedRenderer from './EmbedRenderer.vue'
import { parseArtifacts, hasRichContent } from '../lib/parseArtifacts'
import { copyToClipboard } from '../lib/clipboard'
import { formatApprovalInput, formatDuration, formatToolLabel } from '../lib/format'
import TurnActivity from './TurnActivity.vue'
import { PhX } from '@phosphor-icons/vue'

const ISSUE_TOKEN_RE = new RegExp(ISSUE_KEY_RE.source, 'g')

// Singleton reference index — no per-bubble collection scans.
const { byKey: issueRefsByKey } = useIssueReferences()

function renderUserMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string
  // Only decorate keys that resolve to a real item — "UTF-8" must stay prose.
  return DOMPurify.sanitize(raw).replace(ISSUE_TOKEN_RE, m =>
    issueRefsByKey.value.has(m) ? `<span class="issue-reference" data-issue-key="${m}">${m}</span>` : m
  )
}

// MessageBubble's template always has more than one root (the active v-if
// branch plus a trailing copy-toast Teleport), so Vue can never auto-inherit
// `id` onto a branch root — it must be declared and bound explicitly.
const props = defineProps<{ msg: Message; id?: string }>()
const issueHover = ref<{ key: string; title: string; x: number; y: number } | null>(null)
const userHtml = computed(() => renderUserMarkdown(props.msg.role === 'user' ? props.msg.text : ''))

defineEmits<{
  approve: [requestId: string, approved: boolean]
  openActivity: []
}>()

function updateIssueHover(event: MouseEvent) {
  const token = (event.target as HTMLElement).closest('.issue-reference') as HTMLElement | null
  if (!token) {
    issueHover.value = null
    return
  }
  const key = token.dataset.issueKey ?? ''
  issueHover.value = { key, title: issueRefsByKey.value.get(key)?.title ?? 'Issue reference', x: event.clientX + 14, y: event.clientY + 16 }
}

const segments = computed(() => {
  if (props.msg.role !== 'bond' || !hasRichContent(props.msg.text)) return null
  return parseArtifacts(props.msg.text)
})

const toast = ref<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
let toastTimer: ReturnType<typeof setTimeout> | undefined

const lightbox = ref<{ src: string; alt: string } | null>(null)

function openImage(img: AttachedImage, alt: string) {
  lightbox.value = { src: imageDataUri(img), alt }
}

function closeImage() {
  lightbox.value = null
}

function copyText(msg: Message, event: MouseEvent) {
  let text = ''
  if (msg.role === 'user') text = msg.text
  else if (msg.role === 'bond') text = msg.text
  else if (msg.kind === 'thinking') text = msg.text ?? ''
  else if (msg.kind === 'error' || msg.kind === 'system') text = msg.text
  else return
  if (!text) return
  void copyToClipboard(text)
  window.getSelection()?.removeAllRanges()
  clearTimeout(toastTimer)
  toast.value = { x: event.clientX, y: event.clientY - 8, visible: true }
  toastTimer = setTimeout(() => { toast.value.visible = false }, 1200)
}

/** "for"-prefixed phrasing around the shared core: 'briefly' | 'for 45s' | 'for 1m 15s'. */
function formatThoughtDuration(sec: number | undefined): string {
  const core = formatDuration(sec ?? 0)
  return core === 'briefly' ? core : `for ${core}`
}

function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <!-- User message -->
  <div :id="id" v-if="msg.role === 'user'" class="message-bubble message-bubble--user self-end max-w-[92%] flex flex-col items-end gap-1.5" @dblclick="copyText(msg, $event)" @mousemove="updateIssueHover" @mouseleave="issueHover = null">
    <div v-if="msg.images?.length" class="conversation-image-strip">
      <button
        v-for="(img, i) in msg.images"
        :key="i"
        type="button"
        class="conversation-image-button"
        :aria-label="`Open attached image ${i + 1}`"
        @click="openImage(img, `Attached image ${i + 1}`)"
      >
        <img :src="imageDataUri(img)" class="conversation-image-thumbnail" alt="" />
      </button>
    </div>
    <div
      v-if="msg.text"
      class="user-markdown px-3.5 py-2.5 rounded-[10px] leading-relaxed bg-surface shadow-sm"
      v-html="userHtml"
    />
    <Teleport to="body">
      <div v-if="issueHover" class="issue-hover-card" :style="{ left: issueHover.x + 'px', top: issueHover.y + 'px' }">
        <span class="issue-hover-key">{{ issueHover.key }}</span>
        <span class="issue-hover-title">{{ issueHover.title }}</span>
      </div>
    </Teleport>
    <span v-if="msg.ts" class="msg-timestamp">{{ formatTime(msg.ts) }}</span>
  </div>

  <!-- Bond message: with artifacts -->
  <div
    :id="id"
    v-else-if="msg.role === 'bond' && segments"
    class="message-bubble message-bubble--bond self-start w-full text-sm leading-relaxed"
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
    :id="id"
    v-else-if="msg.role === 'bond'"
    :text="msg.text"
    :streaming="msg.streaming"
    class="message-bubble message-bubble--bond self-start w-full px-3.5 py-2.5 text-sm leading-relaxed"
    @dblclick="copyText(msg, $event)"
  />

  <!-- Turn activity -->
  <TurnActivity
    :id="id"
    v-else-if="msg.kind === 'activity'"
    :data="msg.data"
    @approve="(requestId, approved) => $emit('approve', requestId, approved)"
  />

  <!-- Tool approval -->
  <div
    :id="id"
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

  <!-- Generated image -->
  <div
    :id="id"
    v-else-if="msg.kind === 'image'"
    class="self-start max-w-[92%] flex flex-col items-start gap-1.5 px-3.5"
  >
    <button
      v-for="(img, i) in msg.images ?? []"
      :key="i"
      type="button"
      class="conversation-image-button"
      :aria-label="`Open generated image ${i + 1}`"
      @click="openImage(img, msg.alt ?? 'Generated image')"
    >
      <img
        :src="imageDataUri(img)"
        :alt="msg.alt ?? 'Generated image'"
        class="conversation-image-thumbnail conversation-image-thumbnail--generated max-w-[min(100%,420px)]"
      />
    </button>
    <div
      v-if="!msg.images?.length"
      class="px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
    >
      Loading image…
    </div>
  </div>

  <!-- Thinking: hidden while streaming (activity bar handles it), minimal summary when finalized -->
  <!-- Streaming thinking renders nothing — swallowed so it doesn't hit the v-else catch-all -->
  <template v-else-if="msg.kind === 'thinking' && (msg.streaming || !msg.text)" />
  <span
    :id="id"
    v-else-if="msg.kind === 'thinking'"
    class="activity-summary"
    @click="$emit('openActivity')"
  >Thought {{ formatThoughtDuration(msg.durationSec) }}</span>

  <!-- Skill invocation -->
  <div
    :id="id"
    v-else-if="msg.kind === 'skill'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-accent/40"
  >
    <span class="text-accent font-medium">/{{ msg.name }}</span>
    <span v-if="msg.args"> — {{ msg.args }}</span>
  </div>

  <!-- Tool call — minimal summary -->
  <span
    :id="id"
    v-else-if="msg.kind === 'tool'"
    class="activity-summary"
    @click="$emit('openActivity')"
  >{{ formatToolLabel(msg.name, msg.summary) }}</span>

  <!-- Error -->
  <div
    :id="id"
    v-else-if="msg.kind === 'error'"
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-err border border-dashed border-border"
    @dblclick="copyText(msg, $event)"
  >
    {{ msg.text }}
  </div>

  <!-- System / other meta -->
  <div
    :id="id"
    v-else
    class="self-center max-w-[96%] px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
    @dblclick="copyText(msg, $event)"
  >
    {{ msg.text }}
  </div>
  <Teleport to="body">
    <div
      v-if="lightbox"
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="lightbox.alt"
      @click.self="closeImage"
    >
      <button type="button" class="image-lightbox-close" aria-label="Close image" @click="closeImage">
        <PhX :size="24" weight="bold" />
      </button>
      <img :src="lightbox.src" :alt="lightbox.alt" class="image-lightbox-image" />
    </div>
  </Teleport>
  <Teleport to="body">
    <Transition name="copy-toast">
      <div v-if="toast.visible" class="copy-toast" :style="{ left: toast.x + 'px', top: toast.y + 'px' }">
        Message copied
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.conversation-image-strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.conversation-image-button {
  display: block;
  padding: 0;
  border: 0;
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: zoom-in;
  overflow: hidden;
}

.conversation-image-thumbnail {
  display: block;
  width: 200px;
  height: 200px;
  object-fit: cover;
}

.conversation-image-thumbnail--generated {
  width: min(100%, 420px);
  height: auto;
  max-height: 420px;
  object-fit: contain;
  box-shadow: var(--shadow-sm);
}

.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.94);
}

.image-lightbox-image {
  display: block;
  max-width: 92vw;
  max-height: 84dvh;
  object-fit: contain;
}

.image-lightbox-close {
  position: absolute;
  top: max(16px, env(safe-area-inset-top));
  right: 16px;
  z-index: 1;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  color: white;
  cursor: pointer;
}

@media (max-width: 700px) {
  .conversation-image-thumbnail,
  .conversation-image-thumbnail--generated {
    width: 48px;
    height: 48px;
    max-height: none;
    object-fit: cover;
    box-shadow: none;
  }
}

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
  display: block;
  flex: none;
  white-space: nowrap;
  font-size: 0.625rem;
  line-height: 1;
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
/* The bubble is fit-content inside a max-width cap, so an unbreakable token
   (URL, path, hash) would size the bubble past the cap and overflow the
   transcript. `anywhere` breaks it and keeps the min-content width small. */
.user-markdown { min-width: 0; overflow-wrap: anywhere; }
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
.user-markdown :deep(.issue-reference) {
  display: inline-block;
  padding: 0.05em 0.32em;
  border-radius: 0.3em;
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 0.9em;
  font-weight: 700;
  cursor: default;
}

.issue-hover-card {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  max-width: 260px;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
  pointer-events: none;
}

.issue-hover-key {
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 700;
}

.issue-hover-title {
  color: var(--color-text-primary);
  font-size: 0.78rem;
}
</style>
