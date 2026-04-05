<script setup lang="ts">
import { ref, watch } from 'vue'
import type { SenseCapture } from '../../shared/sense'
import { PhMagnifyingGlass, PhX } from '@phosphor-icons/vue'
import BondText from './BondText.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'

const props = defineProps<{
  results: SenseCapture[]
  query: string
}>()

const emit = defineEmits<{
  search: [query: string]
  select: [capture: SenseCapture]
  clear: []
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const anchorRef = ref<HTMLElement | null>(null)
const localQuery = ref(props.query)
const flyoutOpen = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.query, (q) => { localQuery.value = q })

function handleInput(e: Event) {
  const val = (e.target as HTMLInputElement).value
  localQuery.value = val
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('search', val)
    flyoutOpen.value = val.trim().length > 0
  }, 300)
}

function handleClear() {
  localQuery.value = ''
  emit('clear')
  flyoutOpen.value = false
  inputRef.value?.focus()
}

function handleSelect(cap: SenseCapture) {
  emit('select', cap)
  flyoutOpen.value = false
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    flyoutOpen.value = false
    inputRef.value?.blur()
  }
}

function handleFocus() {
  if (localQuery.value.trim() && props.results.length > 0) {
    flyoutOpen.value = true
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function highlightMatch(text: string, query: string): string {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>')
}

function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div ref="anchorRef" class="sense-search">
    <PhMagnifyingGlass :size="14" class="search-icon" />
    <input
      ref="inputRef"
      type="text"
      :value="localQuery"
      placeholder="Search captures..."
      class="search-input"
      @input="handleInput"
      @keydown="handleKeyDown"
      @focus="handleFocus"
    />
    <button v-if="localQuery" class="clear-btn" @click="handleClear">
      <PhX :size="12" />
    </button>

    <BondFlyoutMenu
      :open="flyoutOpen && results.length > 0"
      :anchor="anchorRef"
      :width="360"
      placement="bottom-start"
      @close="flyoutOpen = false"
    >
      <div class="search-results">
        <button
          v-for="cap in results.slice(0, 20)"
          :key="cap.id"
          class="result-item"
          @click="handleSelect(cap)"
        >
          <div class="result-header">
            <BondText size="xs" weight="medium">{{ cap.appName || 'Unknown' }}</BondText>
            <BondText size="xs" color="muted">{{ formatDate(cap.capturedAt) }} {{ formatTime(cap.capturedAt) }}</BondText>
          </div>
          <BondText v-if="cap.windowTitle" size="xs" color="muted" truncate>{{ cap.windowTitle }}</BondText>
          <BondText
            v-if="cap.textContent"
            size="xs"
            color="muted"
            truncate
            class="result-excerpt"
            v-html="highlightMatch(cap.textContent.slice(0, 120), localQuery)"
          />
        </button>
        <BondText v-if="results.length > 20" size="xs" color="muted" class="p-2 text-center">
          {{ results.length - 20 }} more results...
        </BondText>
      </div>
    </BondFlyoutMenu>
  </div>
</template>

<style scoped>
.sense-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: var(--color-tint);
  border-radius: var(--radius-md);
  padding: 0 0.5rem;
  height: 1.75rem;
  min-width: 180px;
  max-width: 260px;
}

.search-icon {
  color: var(--color-muted);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  min-width: 0;
}

.search-input::placeholder {
  color: var(--color-muted);
  opacity: 0.7;
}

.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--color-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-sm);
}

.clear-btn:hover {
  color: var(--color-text-primary);
}

.search-results {
  max-height: 360px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 0.25rem;
}

.result-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-sm);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background var(--transition-fast);
}

.result-item:hover {
  background: var(--color-tint);
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}

.result-excerpt {
  line-height: 1.3;
}

.result-excerpt :deep(mark) {
  background: var(--color-accent, #f0c040);
  color: inherit;
  border-radius: 1px;
  padding: 0 1px;
}
</style>
