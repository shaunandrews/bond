<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useMemory } from '../composables/useMemory'
import BondToolbar from './BondToolbar.vue'
import BondText from './BondText.vue'
import BondTab from './BondTab.vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondTextarea from './BondTextarea.vue'
import type { CoreMemory, MemoryItem, MemoryItemKind, WorkingState } from '../../shared/memory'

const memory = useMemory()

type TabType = 'core' | 'working' | 'search' | 'source'
const activeTab = ref<TabType>('core')
const query = ref('')
const selectedItem = ref<MemoryItem | null>(null)
const editText = ref('')
const editKind = ref<MemoryItemKind>('fact')

const tabs = [
  { id: 'core', label: 'Core' },
  { id: 'working', label: 'Working' },
  { id: 'search', label: 'Search' },
  { id: 'source', label: 'Source' },
]

const coreDraft = reactive({ facts: '', preferences: '', decisions: '' })
const workingDraft = reactive({ goal: '', facts: '', preferences: '', decisions: '', openThreads: '' })

function lines(value: string): string[] {
  return value.split('\n').map(v => v.trim()).filter(Boolean)
}

function joinLines(values: string[]): string {
  return values.join('\n')
}

function syncCore(value: CoreMemory) {
  coreDraft.facts = joinLines(value.facts)
  coreDraft.preferences = joinLines(value.preferences)
  coreDraft.decisions = joinLines(value.decisions)
}

function syncWorking(value: WorkingState) {
  workingDraft.goal = value.goal
  workingDraft.facts = joinLines(value.facts)
  workingDraft.preferences = joinLines(value.preferences)
  workingDraft.decisions = joinLines(value.decisions)
  workingDraft.openThreads = joinLines(value.openThreads)
}

watch(memory.core, syncCore, { immediate: true })
watch(memory.working, syncWorking, { immediate: true })

const hasSelection = computed(() => selectedItem.value !== null)

async function saveCore() {
  await memory.saveCore({
    ...memory.core.value,
    facts: lines(coreDraft.facts),
    preferences: lines(coreDraft.preferences),
    decisions: lines(coreDraft.decisions),
  })
}

async function saveWorking() {
  await memory.saveWorking({
    ...memory.working.value,
    goal: workingDraft.goal.trim(),
    facts: lines(workingDraft.facts),
    preferences: lines(workingDraft.preferences),
    decisions: lines(workingDraft.decisions),
    openThreads: lines(workingDraft.openThreads),
  })
}

async function clearWorking() {
  await memory.clearWorking()
  syncWorking(memory.working.value)
}

async function runSearch() {
  await memory.search(query.value, 20)
}

const displayedResults = computed(() => memory.results.value)
const displayedSources = computed(() => memory.sources.value.messages)

function selectItem(item: MemoryItem) {
  selectedItem.value = item
  editText.value = item.text
  editKind.value = item.kind
}

async function saveItem() {
  if (!selectedItem.value || !editText.value.trim()) return
  const saved = await memory.upsert({ ...selectedItem.value, kind: editKind.value, text: editText.value.trim() })
  selectItem(saved)
}

async function deleteItem(item: MemoryItem) {
  if (selectedItem.value?.id === item.id) selectedItem.value = null
  await memory.remove(item.id)
}

async function showSource(item: MemoryItem) {
  selectItem(item)
  await memory.loadSources(item.id)
  activeTab.value = 'source'
}

function roleLabel(role: string): string {
  if (role === 'bond') return 'Bond'
  if (role === 'user') return 'User'
  return 'System'
}

onMounted(() => {
  if (memory.isEmpty.value && !memory.loading.value) memory.loadMemory()
})
</script>

<template>
  <div class="memory-panel">
    <BondToolbar label="Memory" drag blur>
      <template #middle>
        <BondText size="sm" weight="medium">Memory</BondText>
      </template>
    </BondToolbar>

    <div class="memory-tabs">
      <BondTab :tabs="tabs" :modelValue="activeTab" @update:modelValue="activeTab = $event as TabType" />
    </div>

    <div class="memory-body">
      <div v-if="memory.error.value" class="notice err">{{ memory.error.value }}</div>
      <div v-if="memory.loading.value" class="memory-empty">
        <BondText size="sm" color="muted">Loading memory...</BondText>
      </div>

      <section v-else-if="activeTab === 'core'" class="stack">
        <BondText size="xs" color="muted">Stable details Bond should keep across work.</BondText>
        <label class="field"><BondText size="xs" weight="semibold">Facts</BondText><BondTextarea v-model="coreDraft.facts" :rows="6" /></label>
        <label class="field"><BondText size="xs" weight="semibold">Preferences</BondText><BondTextarea v-model="coreDraft.preferences" :rows="6" /></label>
        <label class="field"><BondText size="xs" weight="semibold">Decisions</BondText><BondTextarea v-model="coreDraft.decisions" :rows="6" /></label>
        <BondButton size="sm" @click="saveCore" :disabled="memory.saving.value">Save core</BondButton>
      </section>

      <section v-else-if="activeTab === 'working'" class="stack">
        <BondText size="xs" color="muted">Current scratchpad: goal, useful facts, choices, and open threads.</BondText>
        <label class="field"><BondText size="xs" weight="semibold">Goal</BondText><BondInput v-model="workingDraft.goal" /></label>
        <label class="field"><BondText size="xs" weight="semibold">Facts</BondText><BondTextarea v-model="workingDraft.facts" :rows="5" /></label>
        <label class="field"><BondText size="xs" weight="semibold">Preferences</BondText><BondTextarea v-model="workingDraft.preferences" :rows="4" /></label>
        <label class="field"><BondText size="xs" weight="semibold">Decisions</BondText><BondTextarea v-model="workingDraft.decisions" :rows="4" /></label>
        <label class="field"><BondText size="xs" weight="semibold">Open threads</BondText><BondTextarea v-model="workingDraft.openThreads" :rows="4" /></label>
        <div class="actions"><BondButton size="sm" @click="saveWorking" :disabled="memory.saving.value">Save working</BondButton><BondButton size="sm" variant="ghost" @click="clearWorking">Clear</BondButton></div>
      </section>

      <section v-else-if="activeTab === 'search'" class="stack">
        <div class="search-row"><BondInput v-model="query" placeholder="Search memory" @keyup.enter="runSearch" /><BondButton size="sm" @click="runSearch">Search</BondButton></div>
        <div v-if="memory.isEmpty.value" class="memory-empty"><BondText size="sm" color="muted">No memory items found.</BondText></div>
        <div v-else class="results">
          <article v-for="result in displayedResults" :key="result.item.id" class="memory-card" :class="{ active: selectedItem?.id === result.item.id }" @click="selectItem(result.item)">
            <div class="card-head"><span class="kind">{{ result.item.kind }}</span><BondText size="xs" color="muted">{{ result.item.updatedAt.slice(0, 10) }}</BondText></div>
            <BondText size="sm">{{ result.item.text }}</BondText>
            <div class="card-actions"><button @click.stop="showSource(result.item)">Source</button><button @click.stop="deleteItem(result.item)">Delete</button></div>
          </article>
        </div>
        <div v-if="hasSelection" class="editor">
          <select v-model="editKind" class="kind-select"><option value="fact">fact</option><option value="preference">preference</option><option value="decision">decision</option><option value="thread">thread</option></select>
          <BondTextarea v-model="editText" :rows="4" />
          <BondButton size="sm" @click="saveItem">Update item</BondButton>
        </div>
      </section>

      <section v-else class="stack">
        <BondText size="xs" color="muted">Original messages attached to the selected memory item.</BondText>
        <div v-if="displayedSources.length === 0" class="memory-empty"><BondText size="sm" color="muted">Select an item source from Search.</BondText></div>
        <article v-for="msg in displayedSources" :key="msg.id" class="source-card">
          <BondText size="xs" weight="semibold" color="muted">{{ roleLabel(msg.role) }} · #{{ msg.seq }}</BondText>
          <p>{{ msg.text }}</p>
        </article>
      </section>
    </div>
  </div>
</template>

<style scoped>
.memory-panel { height: 100%; display: flex; flex-direction: column; overflow: hidden; border-left: 1px solid var(--color-border); background: var(--color-bg); }
.memory-tabs { padding: 0.375rem 0.75rem; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.memory-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0.75rem; }
.stack { display: flex; flex-direction: column; gap: 0.75rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.actions, .search-row, .card-actions { display: flex; gap: 0.5rem; align-items: center; }
.search-row :deep(input) { flex: 1; }
.results { display: flex; flex-direction: column; gap: 0.5rem; }
.memory-card, .source-card, .editor, .notice { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.625rem; }
.memory-card { cursor: pointer; display: flex; flex-direction: column; gap: 0.5rem; }
.memory-card:hover, .memory-card.active { border-color: var(--color-accent); }
.card-head { display: flex; justify-content: space-between; gap: 0.5rem; }
.kind { font-size: 0.6875rem; color: var(--color-accent); text-transform: uppercase; letter-spacing: 0.05em; }
.card-actions button { border: 0; padding: 0; background: transparent; color: var(--color-accent); font-size: 0.75rem; cursor: pointer; }
.editor { display: flex; flex-direction: column; gap: 0.5rem; }
.kind-select { color: var(--color-text-primary); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 0.25rem; }
.source-card p { margin: 0.35rem 0 0; white-space: pre-wrap; font-size: 0.8125rem; line-height: 1.45; }
.memory-empty { display: flex; align-items: center; justify-content: center; min-height: 8rem; padding: 1rem; text-align: center; }
.notice.err { color: var(--color-err); }
</style>
