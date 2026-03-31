<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
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

// Encode spaces in markdown image paths so marked.js doesn't break on them
// ![alt](/path/with spaces/file.png) → ![alt](/path/with%20spaces/file.png)
function encodeImagePaths(md: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    if (url.startsWith('http') || url.startsWith('data:')) return _match
    return `![${alt}](${url.replace(/ /g, '%20')})`
  })
}

function renderMarkdown() {
  const raw = marked.parse(encodeImagePaths(props.text), {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  }) as string
  sanitizedHtml.value = DOMPurify.sanitize(raw, { ADD_ATTR: ['data-code'] })
  nextTick(resolveLocalImages)
}

async function resolveLocalImages() {
  if (!rootEl.value) return
  const imgs = rootEl.value.querySelectorAll('img') as NodeListOf<HTMLImageElement>
  for (const img of imgs) {
    const src = img.getAttribute('src')
    if (!src || !src.startsWith('/') || src.startsWith('data:')) continue
    if (!/\.(png|jpe?g|gif|webp)$/i.test(src)) continue
    const filePath = decodeURIComponent(src)
    const dataUri = await window.bond.readLocalImage(filePath)
    if (dataUri) img.src = dataUri
  }
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
const lightboxSrc = ref<string | null>(null)

function handleClick(e: MouseEvent) {
  const target = e.target as HTMLElement

  // Open links in default browser
  const anchor = target.closest('a') as HTMLAnchorElement | null
  if (anchor?.href) {
    e.preventDefault()
    window.bond.openExternal(anchor.href)
    return
  }

  // Copy code block
  const btn = target.closest('.code-block-copy') as HTMLElement | null
  if (!btn) return
  const code = btn.dataset.code ?? ''
  navigator.clipboard.writeText(code)
  btn.textContent = 'Copied!'
  setTimeout(() => { btn.textContent = 'Copy' }, 1500)
}

function handleDblClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'IMG') {
    e.preventDefault()
    e.stopPropagation()
    lightboxSrc.value = (target as HTMLImageElement).src
  }
}

function closeLightbox() {
  lightboxSrc.value = null
}

onMounted(() => {
  rootEl.value?.addEventListener('click', handleClick)
  rootEl.value?.addEventListener('dblclick', handleDblClick)
})
onUnmounted(() => {
  rootEl.value?.removeEventListener('click', handleClick)
  rootEl.value?.removeEventListener('dblclick', handleDblClick)
  if (rafId !== null) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div ref="rootEl" class="bond-message" v-html="sanitizedHtml" />
  <Teleport to="body">
    <Transition name="lightbox">
      <div v-if="lightboxSrc" class="lightbox-overlay" @click="closeLightbox">
        <img :src="lightboxSrc" class="lightbox-img" @click.stop />
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.bond-message img {
  max-width: min(100%, 480px);
  max-height: 360px;
  object-fit: contain;
  border-radius: var(--radius-lg);
  margin: 0.5em 0;
  border: 1px solid var(--color-border);
  cursor: zoom-in;
}

.lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
  padding: 2rem;
}

.lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity 0.15s ease;
}
.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}
.bond-message p { margin: 0; }
.bond-message p + p { margin-top: 0.5em; }
.bond-message strong { font-weight: 600; }
.bond-message em { font-style: italic; }
.bond-message ul, .bond-message ol { margin: 0.4em 0; padding-left: 1.4em; }
.bond-message li { margin: 0.15em 0; }
.bond-message a { color: var(--color-accent); text-decoration: underline; }
.bond-message hr { border: none; border-top: 1px solid var(--color-border); margin: 0.6em 0; }

.bond-message h1 { font-size: 1.15em; font-weight: 600; margin: 0.6em 0 0.3em; }
.bond-message h2 { font-size: 1.08em; font-weight: 600; margin: 0.6em 0 0.3em; }
.bond-message h3 { font-size: 1em; font-weight: 600; margin: 0.6em 0 0.3em; }

.bond-message blockquote {
  border-left: 3px solid var(--color-border);
  margin: 0.4em 0;
  padding-left: 0.8em;
  color: var(--color-muted);
}

.bond-message code {
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 0.15em 0.4em;
  border-radius: var(--radius-sm);
  font-size: 0.88em;
  font-family: var(--font-mono);
}

.bond-message .code-block {
  margin: 0.6em 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.bond-message .code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.35em 0.75em;
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  font-size: 0.75em;
  color: var(--color-muted);
}
.bond-message .code-block-lang {
  font-family: var(--font-mono);
  text-transform: lowercase;
}
.bond-message .code-block-copy {
  all: unset;
  cursor: pointer;
  font-size: 0.85em;
  color: var(--color-muted);
  padding: 0.15em 0.5em;
  border-radius: var(--radius-sm);
  transition: color var(--transition-base), background var(--transition-base);
}
.bond-message .code-block-copy:hover {
  color: var(--color-text-primary);
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
}
.bond-message .code-block pre {
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0.75em 1em;
  overflow-x: auto;
  font-size: 0.88em;
  line-height: 1.55;
}
.bond-message .code-block pre code {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

.bond-message table {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.9em;
  width: 100%;
}
.bond-message th, .bond-message td {
  border: 1px solid var(--color-border);
  padding: 0.35em 0.6em;
  text-align: left;
}
.bond-message th {
  font-weight: 600;
  background: color-mix(in srgb, var(--color-border) 30%, transparent);
}

.bond-message ul:has(input[type="checkbox"]) {
  list-style: none;
  padding-left: 0.2em;
}
.bond-message input[type="checkbox"] {
  margin-right: 0.4em;
  accent-color: var(--color-accent);
}

/* Syntax highlighting */
.hljs { color: var(--color-text-primary); }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #b07d4f; }
.hljs-string, .hljs-attr { color: #2e7d32; }
.hljs-comment, .hljs-quote { color: var(--color-muted); font-style: italic; }
.hljs-number, .hljs-literal { color: #c62828; }
.hljs-title, .hljs-section { color: #b07d4f; font-weight: 600; }
.hljs-type, .hljs-class .hljs-title { color: #1565c0; }
.hljs-meta { color: var(--color-muted); }
.hljs-variable, .hljs-template-variable { color: #6a1b9a; }
.hljs-function { color: #1565c0; }
.hljs-params { color: var(--color-text-primary); }

@media (prefers-color-scheme: dark) {
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #c4a07c; }
  .hljs-string, .hljs-attr { color: #a5d6a7; }
  .hljs-number, .hljs-literal { color: #f48fb1; }
  .hljs-title, .hljs-section { color: #c4a07c; font-weight: 600; }
  .hljs-type, .hljs-class .hljs-title, .hljs-function { color: #81d4fa; }
  .hljs-variable, .hljs-template-variable { color: #ce93d8; }
}
</style>
