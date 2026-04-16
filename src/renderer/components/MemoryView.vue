<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useMemory } from '../composables/useMemory'
import BondToolbar from './BondToolbar.vue'
import BondText from './BondText.vue'
import BondTab from './BondTab.vue'
import MemoryFactCard from './MemoryFactCard.vue'
import MemoryThreadCard from './MemoryThreadCard.vue'
import MemoryDecisionItem from './MemoryDecisionItem.vue'
import MemoryDebriefCard from './MemoryDebriefCard.vue'
import MemoryDebriefDetail from './MemoryDebriefDetail.vue'
import type { SessionDebrief } from '../../shared/sense'

const memory = useMemory()

type FilterType = 'all' | 'facts' | 'threads' | 'decisions' | 'prompt'
const filter = ref<FilterType>('all')
const activeDebrief = ref<SessionDebrief | null>(null)

// System prompt preview state
const promptPreview = ref('')
const promptLoading = ref(false)

const filterTabs = [
  { id: 'all', label: 'All' },
  { id: 'facts', label: 'Facts' },
  { id: 'threads', label: 'Threads' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'prompt', label: 'Prompt' },
]

const showFacts = computed(() => filter.value === 'all' || filter.value === 'facts')
const showThreads = computed(() => filter.value === 'all' || filter.value === 'threads')
const showDecisions = computed(() => filter.value === 'all' || filter.value === 'decisions')
const showDebriefs = computed(() => filter.value === 'all' || filter.value === 'decisions')
const showPrompt = computed(() => filter.value === 'prompt')

async function loadPromptPreview() {
  promptLoading.value = true
  try {
    const result = await window.bond.senseSystemPromptPreview()
    promptPreview.value = result.prompt
  } catch (err) {
    console.error('Failed to load prompt preview:', err)
    promptPreview.value = 'Failed to load system prompt preview.'
  } finally {
    promptLoading.value = false
  }
}

// Load prompt when switching to that tab
watch(filter, (val) => {
  if (val === 'prompt' && !promptPreview.value) {
    loadPromptPreview()
  }
})

function handleSelectDebrief(id: string) {
  const d = memory.debriefs.value.find(db => db.id === id)
  if (d) activeDebrief.value = d
}

function handleBackFromDebrief() {
  activeDebrief.value = null
}

function handlePinFact(fact: string) {
  memory.pinFact(fact)
}

function handleUpdateFact(id: string, text: string) {
  memory.updateFact(id, text)
}

function handleDismissThread(debriefId: string, thread: string) {
  memory.dismissThread(debriefId, thread)
}

function handleRemoveDecision(debriefId: string, decision: string) {
  memory.removeDecision(debriefId, decision)
}

function handleDeleteDebrief(id: string) {
  memory.deleteDebrief(id)
  activeDebrief.value = null
}

function handleResumeThread(sessionId: string) {
  console.log('Resume thread from session:', sessionId)
}

onMounted(() => {
  if (memory.facts.value.length === 0 && memory.debriefs.value.length === 0 && !memory.loading.value) {
    memory.loadMemory()
  }
})
</script>

<template>
  <!-- Detail view for a selected debrief -->
  <MemoryDebriefDetail
    v-if="activeDebrief"
    :debrief="activeDebrief"
    @back="handleBackFromDebrief"
    @pinFact="handlePinFact"
    @delete="handleDeleteDebrief"
  />

  <!-- List view -->
  <div v-else class="memory-panel">
    <BondToolbar label="Memory" drag blur>
      <template #middle>
        <BondText size="sm" weight="medium">Memory</BondText>
      </template>
    </BondToolbar>

    <div class="memory-filter">
      <BondTab :tabs="filterTabs" :modelValue="filter" @update:modelValue="filter = $event as FilterType" />
    </div>

    <!-- System Prompt preview -->
    <div v-if="showPrompt" class="memory-body">
      <div v-if="promptLoading" class="memory-empty">
        <BondText size="sm" color="muted">Loading prompt...</BondText>
      </div>
      <div v-else class="prompt-preview">
        <div class="prompt-header">
          <BondText size="xs" color="muted">
            This is the full system prompt Bond would inject into a new chat right now.
            Editing facts, threads, and decisions above changes what appears here.
          </BondText>
          <button class="prompt-refresh" @click="loadPromptPreview">
            <BondText size="xs" color="accent">Refresh</BondText>
          </button>
        </div>
        <pre class="prompt-text">{{ promptPreview }}</pre>
      </div>
    </div>

    <!-- Memory sections -->
    <div v-else class="memory-body">
      <!-- Loading -->
      <div v-if="memory.loading.value" class="memory-empty">
        <BondText size="sm" color="muted">Loading memory...</BondText>
      </div>

      <!-- Empty state -->
      <div v-else-if="memory.isEmpty.value" class="memory-empty">
        <BondText size="sm" color="muted">No memories yet. Bond builds memory as you archive sessions.</BondText>
      </div>

      <!-- Content sections -->
      <template v-else>
        <!-- Pinned Facts -->
        <section v-if="showFacts && memory.facts.value.length > 0" class="memory-section">
          <BondText size="xs" weight="semibold" color="muted" as="h3" class="section-heading">
            Pinned Facts ({{ memory.facts.value.length }})
          </BondText>
          <div class="facts-grid">
            <MemoryFactCard
              v-for="fact in memory.facts.value"
              :key="fact.id"
              :fact="fact"
              @forget="memory.forgetFact($event)"
              @update="handleUpdateFact"
            />
          </div>
        </section>

        <div v-if="showFacts && memory.facts.value.length === 0 && filter === 'facts'" class="memory-empty-section">
          <BondText size="xs" color="muted">No pinned facts. Say "remember that..." in a chat to pin one.</BondText>
        </div>

        <!-- Open Threads -->
        <section v-if="showThreads && memory.threads.value.length > 0" class="memory-section">
          <BondText size="xs" weight="semibold" color="muted" as="h3" class="section-heading">
            Open Threads ({{ memory.threads.value.length }})
          </BondText>
          <div class="threads-list">
            <MemoryThreadCard
              v-for="(thread, i) in memory.threads.value"
              :key="i"
              :thread="thread"
              @resume="handleResumeThread"
              @dismiss="handleDismissThread"
            />
          </div>
        </section>

        <div v-if="showThreads && memory.threads.value.length === 0 && filter === 'threads'" class="memory-empty-section">
          <BondText size="xs" color="muted">No open threads. Nice — everything's resolved.</BondText>
        </div>

        <!-- Recent Decisions -->
        <section v-if="showDecisions && memory.decisions.value.length > 0" class="memory-section">
          <BondText size="xs" weight="semibold" color="muted" as="h3" class="section-heading">
            Recent Decisions
          </BondText>
          <div class="decisions-list">
            <MemoryDecisionItem
              v-for="(decision, i) in memory.decisions.value"
              :key="i"
              :decision="decision"
              @remove="handleRemoveDecision"
            />
          </div>
        </section>

        <!-- Session Debriefs -->
        <section v-if="showDebriefs && memory.debriefs.value.length > 0" class="memory-section">
          <BondText size="xs" weight="semibold" color="muted" as="h3" class="section-heading">
            Session Debriefs
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
      </template>
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

.memory-filter {
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

.facts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.375rem;
}

.threads-list,
.debriefs-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.decisions-list {
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.375rem 0.625rem;
}

.memory-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  text-align: center;
}

.memory-empty-section {
  padding: 1rem 0.125rem;
  text-align: center;
}

/* Prompt preview */
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
