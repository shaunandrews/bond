<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import MarkdownMessage from './MarkdownMessage.vue'
import BondText from './BondText.vue'

const props = defineProps<{ filePath: string }>()

const content = ref('')
const loading = ref(true)
const error = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null

async function loadFile() {
  try {
    const text = await window.bond.readFile(props.filePath)
    if (text === null) {
      error.value = 'File not found or cannot be read.'
    } else {
      content.value = text
      error.value = ''
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to read file.'
  } finally {
    loading.value = false
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(loadFile, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(() => props.filePath, () => {
  loading.value = true
  error.value = ''
  content.value = ''
  loadFile()
  startPolling()
}, { immediate: false })

onMounted(() => {
  loadFile()
  startPolling()
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <div class="md-viewer">
    <div v-if="loading" class="md-viewer-status">
      <BondText size="sm" color="muted">Loading...</BondText>
    </div>
    <div v-else-if="error" class="md-viewer-status">
      <BondText size="sm" color="err">{{ error }}</BondText>
    </div>
    <div v-else class="md-viewer-body">
      <MarkdownMessage :text="content" :streaming="false" />
    </div>
  </div>
</template>

<style scoped>
.md-viewer {
  min-height: 0;
}

.md-viewer-status {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
}

.md-viewer-body {
  padding: 0.75rem 1rem 2rem;
}
</style>
