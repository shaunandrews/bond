<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import hljs from '../lib/highlight'

const props = defineProps<{ text: string; streaming: boolean }>()

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const renderer = new Renderer()

renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : null
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value
  const label = lang || 'text'

  return `<div class="code-block">
    <div class="code-block-header">
      <span class="code-block-lang">${escapeAttr(label)}</span>
      <button class="code-block-copy" data-code="${escapeAttr(text)}">Copy</button>
    </div>
    <pre><code class="hljs">${highlighted}</code></pre>
  </div>`
}

/* ---- Throttled markdown rendering ---- */

const sanitizedHtml = ref('')
let rafId: number | null = null

function renderMarkdown() {
  const raw = marked.parse(props.text, {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  }) as string
  sanitizedHtml.value = DOMPurify.sanitize(raw, { ADD_ATTR: ['data-code'] })
}

// Re-render when text changes, throttled during streaming
watch(
  () => props.text,
  () => {
    if (!props.streaming) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      renderMarkdown()
      return
    }
    if (rafId === null) {
      rafId = requestAnimationFrame(() => { rafId = null; renderMarkdown() })
    }
  },
  { immediate: true }
)

// Final render when streaming ends
watch(
  () => props.streaming,
  (streaming, wasStreaming) => {
    if (wasStreaming && !streaming) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      renderMarkdown()
    }
  }
)

const rootEl = ref<HTMLElement | null>(null)

function handleClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.code-block-copy') as HTMLElement | null
  if (!btn) return
  const code = btn.dataset.code ?? ''
  navigator.clipboard.writeText(code)
  btn.textContent = 'Copied!'
  setTimeout(() => { btn.textContent = 'Copy' }, 1500)
}

onMounted(() => rootEl.value?.addEventListener('click', handleClick))
onUnmounted(() => {
  rootEl.value?.removeEventListener('click', handleClick)
  if (rafId !== null) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div ref="rootEl" class="bond-message" v-html="sanitizedHtml" />
</template>
