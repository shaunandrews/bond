<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
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

const sanitizedHtml = computed(() => {
  const raw = marked.parse(props.text, {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  }) as string
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-code'] })
})

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
onUnmounted(() => rootEl.value?.removeEventListener('click', handleClick))
</script>

<template>
  <div ref="rootEl" class="bond-message" v-html="sanitizedHtml" />
</template>
