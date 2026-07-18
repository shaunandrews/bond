<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useMemory } from '../composables/useMemory'
import BondToolbar from './BondToolbar.vue'
import BondText from './BondText.vue'
import BondTab from './BondTab.vue'
import MemoryDebriefCard from './MemoryDebriefCard.vue'
import MemoryDebriefDetail from './MemoryDebriefDetail.vue'
import type { SessionDebrief } from '../../shared/sense'

const props = defineProps<{
  editMode?: import('../../shared/session').EditMode
}>()
const memory = useMemory()
const emit = defineEmits<{ (e: 'openSession', sessionId: string): void }>()

type TabType = 'debriefs' | 'prompt'
const activeTab = ref<TabType>('debriefs')
const activeDebrief = ref<SessionDebrief | null>(null)
const promptPreview = ref('')
const promptLoading = ref(false)

const tabs = [
  { id: 'debriefs', label: 'Debriefs' },
  { id: 'prompt', label: 'Prompt' },
]

const showPrompt = computed(() => activeTab.value === 'prompt')

function serializableEditMode(): import('../../shared/session').EditMode | undefined {
  if (!props.editMode) return undefined
  if (props.editMode.type === 'scoped') {
    return { type: 'scoped', allowedPaths: [...props.editMode.allowedPaths] }
  }
  return { type: props.editMode.type }
}

async function loadPromptPreview() {
  promptLoading.value = true
  try {
    const result = await window.bond.senseSystemPromptPreview(serializableEditMode())
    promptPreview.value = result.prompt
  } catch (err) {
    console.error('Failed to load prompt preview:', err)
    const message = err instanceof Error ? err.message : String(err)
    promptPreview.value = `Failed to load system prompt preview: ${message}`
  } finally {
    promptLoading.value = false
  }
}

watch([activeTab, () => props.editMode], ([val]) => {
  if (val === 'prompt') loadPromptPreview()
})

function handleSelectDebrief(id: string) {
  const d = memory.debriefs.value.find(db => db.id === id)
  if (d) activeDebrief.value = d
}

function handleDeleteDebrief(id: string) {
  memory.deleteDebrief(id)
  activeDebrief.value = null
}

onMounted(() => {
  if (memory.debriefs.value.length === 0 && !memory.loading.value) {
    memory.loadMemory()
  }
})
</script>

<template>
  <MemoryDebriefDetail
    v-if="activeDebrief"
    :debrief="activeDebrief"
    @back="activeDebrief = null"
    @delete="handleDeleteDebrief"
    @openSession="emit('openSession', $event)"
  />

  <div v-else class="memory-panel">
    <BondToolbar label="Memory" drag blur>
      <template #middle>
        <BondText size="sm" weight="medium">Memory</BondText>
      </template>
    </BondToolbar>

    <div class="memory-tabs">
      <BondTab :tabs="tabs" :modelValue="activeTab" @update:modelValue="activeTab = $event as TabType" />
    </div>

    <div v-if="showPrompt" class="memory-body">
      <div v-if="promptLoading" class="memory-empty">
        <BondText size="sm" color="muted">Loading prompt...</BondText>
      </div>
      <div v-else class="prompt-preview">
        <div class="prompt-header">
          <BondText size="xs" color="muted">
            Exact full system prompt used for a new Bond query right now.
          </BondText>
          <button class="prompt-refresh" @click="loadPromptPreview">
            <BondText size="xs" color="accent">Refresh</BondText>
          </button>
        </div>
        <pre class="prompt-text">{{ promptPreview }}</pre>
      </div>
    </div>

    <div v-else class="memory-body">
      <div v-if="memory.loading.value" class="memory-empty">
        <BondText size="sm" color="muted">Loading debriefs...</BondText>
      </div>

      <div v-else-if="memory.isEmpty.value" class="memory-empty">
        <BondText size="sm" color="muted">No debriefs yet. Archive sessions to generate them.</BondText>
      </div>

      <section v-else class="memory-section">
        <BondText size="xs" weight="semibold" color="muted" as="h3" class="section-heading">
          Session Debriefs ({{ memory.debriefs.value.length }})
        </BondText>
        <div class="debriefs-list">
          <MemoryDebriefCard
            v-for="debrief in memory.debriefs.value"
            :key="debrief.id"
            :debrief="debrief"
            @select="handleSelectDebrief"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.memory-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.memory-tabs {
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.memory-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.memory-section {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.section-heading {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 0.125rem;
}

.debriefs-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.memory-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  text-align: center;
}

.prompt-preview {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.prompt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.prompt-refresh {
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.prompt-refresh:hover {
  opacity: 0.8;
}

.prompt-text {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  overflow-x: hidden;
}
</style>
