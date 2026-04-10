<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  content: string
  title?: string
  layout?: 'normal' | 'wide' | 'full'
  chrome?: 'default' | 'none'
  streaming?: boolean
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)
const height = ref(120) // default min height

/** Read Bond's current color tokens from the host document */
function getColorTokens(): string {
  const style = getComputedStyle(document.documentElement)
  const get = (name: string) => style.getPropertyValue(name).trim()
  return `
    :root {
      --color-bg: ${get('--color-bg')};
      --color-surface: ${get('--color-surface')};
      --color-border: ${get('--color-border')};
      --color-text-primary: ${get('--color-text-primary')};
      --color-muted: ${get('--color-muted')};
      --color-accent: ${get('--color-accent')};
      --color-err: ${get('--color-err')};
      --color-ok: ${get('--color-ok')};
      --color-tint: ${get('--color-tint')};
      --radius-sm: ${get('--radius-sm')};
      --radius-md: ${get('--radius-md')};
      --radius-lg: ${get('--radius-lg')};
      --radius-xl: ${get('--radius-xl')};
      --shadow-sm: ${get('--shadow-sm')};
      --shadow-md: ${get('--shadow-md')};
      --font-sans: ${get('--font-sans')};
      --font-mono: ${get('--font-mono')};
      color-scheme: ${style.colorScheme || 'light dark'};
    }
  `
}

const srcdoc = computed(() => {
  const tokens = getColorTokens()
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${tokens}
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--color-accent); }
a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; }
img.broken { display: none; }
</style>
<script>
// Intercept link clicks and send to parent
document.addEventListener('click', function(e) {
  var anchor = e.target.closest('a');
  if (anchor && anchor.href) {
    e.preventDefault();
    window.parent.postMessage({ type: 'bond:openExternal', url: anchor.href }, '*');
  }
});

// Handle broken images: hide them gracefully
document.addEventListener('error', function(e) {
  if (e.target && e.target.tagName === 'IMG') {
    e.target.classList.add('broken');
    reportHeight();
  }
}, true);

// Auto-resize: report content height to parent
var _resizeTimer;
function reportHeight() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(function() {
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'bond:resize', height: h }, '*');
  }, 16);
}
var ro = new ResizeObserver(reportHeight);
ro.observe(document.documentElement);
// Also report on load and after images
window.addEventListener('load', reportHeight);
document.addEventListener('DOMContentLoaded', reportHeight);
<\/script>
</head>
<body>
${props.content}
</body>
</html>`
})

function handleMessage(e: MessageEvent) {
  if (!iframeRef.value || e.source !== iframeRef.value.contentWindow) return
  const data = e.data
  if (!data || typeof data.type !== 'string') return

  switch (data.type) {
    case 'bond:resize':
      if (typeof data.height === 'number' && data.height > 0) {
        height.value = Math.max(40, Math.ceil(data.height))
      }
      break
    case 'bond:openExternal':
      if (typeof data.url === 'string') {
        window.bond.openExternal(data.url)
      }
      break
    case 'bond:createTodo':
      if (typeof data.text === 'string') {
        window.bond.createTodo(data.text, data.notes, data.group)
      }
      break
    case 'bond:copyText':
      if (typeof data.text === 'string') {
        navigator.clipboard.writeText(data.text)
      }
      break
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage)
})

onUnmounted(() => {
  window.removeEventListener('message', handleMessage)
})

// Refresh srcdoc when content changes (streaming)
watch(srcdoc, (doc) => {
  if (iframeRef.value) {
    iframeRef.value.srcdoc = doc
  }
})
</script>

<template>
  <div
    class="artifact-frame"
    :class="[
      layout === 'wide' && 'artifact-wide',
      layout === 'full' && 'artifact-full',
      chrome === 'none' && 'artifact-chromeless',
    ]"
  >
    <div v-if="title && chrome !== 'none'" class="artifact-header">
      <span class="artifact-title">{{ title }}</span>
    </div>
    <iframe
      ref="iframeRef"
      :srcdoc="srcdoc"
      sandbox="allow-scripts"
      :style="{ height: height + 'px' }"
      class="artifact-iframe"
      frameborder="0"
    />
  </div>
</template>

<style scoped>
.artifact-frame {
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  overflow: hidden;
  margin: 0.5em 0;
  background: var(--color-bg);
}

.artifact-header {
  padding: 0.35em 0.75em;
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  border-bottom: 1px solid var(--color-border);
}

.artifact-title {
  font-size: 0.75em;
  color: var(--color-muted);
  font-weight: 500;
}

.artifact-iframe {
  width: 100%;
  border: none;
  display: block;
  transition: height 0.15s ease;
}

.artifact-chromeless {
  border: none;
  border-radius: 0;
  background: transparent;
}

.artifact-wide {
  width: min(960px, 100cqi);
  max-width: none;
  margin-inline: calc((100% - min(960px, 100cqi)) / 2);
}

.artifact-full {
  width: 100cqi;
  max-width: none;
  margin-inline: calc(50% - 50cqi);
}
</style>
