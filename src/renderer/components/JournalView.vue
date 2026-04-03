<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import type { JournalEntry } from '../../shared/session'
import { PhPlus, PhArrowLeft, PhPushPin, PhTrash, PhPencilSimple, PhMagnifyingGlass, PhX, PhRobot, PhUser } from '@phosphor-icons/vue'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondTextarea from './BondTextarea.vue'
import ViewShell from './ViewShell.vue'
import MarkdownMessage from './MarkdownMessage.vue'

const props = defineProps<{
  entries: JournalEntry[]
  activeEntryId: string | null
  generatingMetaId: string | null
  loading: boolean
  insetStart?: boolean
}>()

const emit = defineEmits<{
  select: [id: string | null]
  createAndGenerate: [body: string, projectId?: string]
  update: [id: string, updates: Partial<Pick<JournalEntry, 'title' | 'body' | 'tags' | 'pinned' | 'projectId'>>]
  remove: [id: string]
  search: [query: string]
  load: [opts?: { author?: string; projectId?: string; tag?: string; limit?: number }]
  togglePin: [id: string]
}>()

const activeEntry = computed(() =>
  props.entries.find(e => e.id === props.activeEntryId) ?? null
)

// Compose state
const composing = ref(false)
const composeBody = ref('')
const composeRef = ref<InstanceType<typeof BondTextarea> | null>(null)

// Search state
const searching = ref(false)
const searchQuery = ref('')

// Edit state
const editing = ref(false)
const editBody = ref('')

function startCompose() {
  composing.value = true
  composeBody.value = ''
  nextTick(() => composeRef.value?.$el?.querySelector('textarea')?.focus())
}

function cancelCompose() {
  composing.value = false
}

function submitCompose() {
  if (!composeBody.value.trim()) return
  emit('createAndGenerate', composeBody.value.trim())
  composing.value = false
}

function handleSearch() {
  if (searchQuery.value.trim()) {
    emit('search', searchQuery.value.trim())
  } else {
    emit('load')
    searching.value = false
  }
}

function clearSearch() {
  searchQuery.value = ''
  searching.value = false
  emit('load')
}

function startEdit() {
  if (!activeEntry.value) return
  editing.value = true
  editBody.value = activeEntry.value.body
}

function cancelEdit() {
  editing.value = false
}

function submitEdit() {
  if (!activeEntry.value || !editBody.value.trim()) return
  emit('update', activeEntry.value.id, { body: editBody.value.trim() })
  editing.value = false
}

function handleDelete(id: string) {
  emit('remove', id)
  emit('select', null)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <ViewShell
    :title="activeEntry ? activeEntry.title : 'Journal'"
    :insetStart="insetStart"
  >
    <template #header-start>
      <slot name="header-start" />
      <BondButton v-if="activeEntry" variant="ghost" size="sm" icon @click="emit('select', null); editing = false" v-tooltip="'Back to list'">
        <PhArrowLeft :size="16" weight="bold" />
      </BondButton>
    </template>

    <template #header-end>
      <template v-if="!activeEntry">
        <BondButton v-if="!searching" variant="ghost" size="sm" icon @click="searching = true" v-tooltip="'Search'">
          <PhMagnifyingGlass :size="16" weight="bold" />
        </BondButton>
        <div v-else class="search-bar">
          <BondInput
            :modelValue="searchQuery"
            @update:modelValue="searchQuery = $event"
            placeholder="Search entries..."
            @keydown.enter="handleSearch"
          />
          <BondButton variant="ghost" size="sm" icon @click="clearSearch">
            <PhX :size="14" weight="bold" />
          </BondButton>
        </div>
        <BondButton variant="ghost" size="sm" icon @click="startCompose" v-tooltip="'New entry'">
          <PhPlus :size="16" weight="bold" />
        </BondButton>
      </template>
      <template v-else-if="activeEntry.author === 'user'">
        <BondButton variant="ghost" size="sm" icon @click="emit('togglePin', activeEntry.id)" v-tooltip="activeEntry.pinned ? 'Unpin' : 'Pin'">
          <PhPushPin :size="16" :weight="activeEntry.pinned ? 'fill' : 'bold'" />
        </BondButton>
        <BondButton variant="ghost" size="sm" icon @click="startEdit" v-tooltip="'Edit'">
          <PhPencilSimple :size="16" weight="bold" />
        </BondButton>
        <BondButton variant="ghost" size="sm" icon @click="handleDelete(activeEntry.id)" v-tooltip="'Delete'">
          <PhTrash :size="16" weight="bold" />
        </BondButton>
      </template>
      <template v-else>
        <BondButton variant="ghost" size="sm" icon @click="emit('togglePin', activeEntry.id)" v-tooltip="activeEntry.pinned ? 'Unpin' : 'Pin'">
          <PhPushPin :size="16" :weight="activeEntry.pinned ? 'fill' : 'bold'" />
        </BondButton>
      </template>
    </template>

    <!-- Compose -->
    <div v-if="composing" class="compose-form">
      <BondTextarea
        ref="composeRef"
        :modelValue="composeBody"
        @update:modelValue="composeBody = $event"
        placeholder="Write something..."
        :rows="12"
      />
      <div class="compose-actions">
        <BondButton variant="secondary" size="sm" @click="cancelCompose">Cancel</BondButton>
        <BondButton variant="primary" size="sm" :disabled="!composeBody.trim()" @click="submitCompose">Save</BondButton>
      </div>
    </div>

    <!-- Edit -->
    <div v-else-if="editing && activeEntry" class="compose-form">
      <BondTextarea
        :modelValue="editBody"
        @update:modelValue="editBody = $event"
        placeholder="Write something..."
        :rows="12"
      />
      <div class="compose-actions">
        <BondButton variant="secondary" size="sm" @click="cancelEdit">Cancel</BondButton>
        <BondButton variant="primary" size="sm" :disabled="!editBody.trim()" @click="submitEdit">Save</BondButton>
      </div>
    </div>

    <!-- Detail view -->
    <div v-else-if="activeEntry" class="entry-detail">
      <div class="entry-meta">
        <span class="entry-author-badge" :class="activeEntry.author">
          <PhRobot v-if="activeEntry.author === 'bond'" :size="12" />
          <PhUser v-else :size="12" />
          {{ activeEntry.author === 'bond' ? 'Bond' : 'You' }}
        </span>
        <BondText size="xs" color="muted">{{ formatDate(activeEntry.createdAt) }} at {{ formatTime(activeEntry.createdAt) }}</BondText>
        <PhPushPin v-if="activeEntry.pinned" :size="12" weight="fill" class="pin-icon" />
      </div>
      <div v-if="activeEntry.tags.length" class="entry-tags">
        <span v-for="tag in activeEntry.tags" :key="tag" class="entry-tag">{{ tag }}</span>
      </div>
      <div class="entry-body">
        <MarkdownMessage :text="activeEntry.body" :streaming="false" />
      </div>
    </div>

    <!-- List view -->
    <div v-else class="journal-list">
      <BondText v-if="loading" as="p" size="sm" color="muted" class="px-5 py-8 text-center">Loading...</BondText>
      <BondText v-else-if="entries.length === 0" as="p" size="sm" color="muted" class="px-5 py-8 text-center">
        No journal entries yet. Click + to write one.
      </BondText>
      <div v-else class="entry-list">
        <button
          v-for="entry in entries"
          :key="entry.id"
          class="entry-card"
          @click="emit('select', entry.id)"
        >
          <div class="entry-card-header">
            <span class="entry-author-badge small" :class="entry.author">
              <PhRobot v-if="entry.author === 'bond'" :size="10" />
              <PhUser v-else :size="10" />
            </span>
            <BondText size="sm" weight="medium" truncate class="flex-1 min-w-0" :color="generatingMetaId === entry.id ? 'muted' : 'primary'">
              {{ generatingMetaId === entry.id ? 'Naming...' : entry.title }}
            </BondText>
            <PhPushPin v-if="entry.pinned" :size="12" weight="fill" class="pin-icon" />
            <BondText size="xs" color="muted" class="shrink-0">{{ formatDate(entry.createdAt) }}</BondText>
          </div>
          <BondText v-if="entry.body" size="xs" color="muted" truncate class="entry-preview">
            {{ entry.body.split('\n')[0].slice(0, 120) }}
          </BondText>
          <div v-if="entry.tags.length" class="entry-tags compact">
            <span v-for="tag in entry.tags" :key="tag" class="entry-tag small">{{ tag }}</span>
          </div>
        </button>
      </div>
    </div>
  </ViewShell>
</template>

<style scoped>
.journal-list {
  flex: 1;
}

.entry-list {
  display: flex;
  flex-direction: column;
  padding: 0.5rem;
}

.entry-card {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-md);
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: background var(--transition-fast);
}
.entry-card:hover {
  background: var(--color-tint);
}

.entry-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.entry-preview {
  padding-left: 1.5rem;
}

.entry-author-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.1875rem 0.375rem;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.entry-author-badge.bond {
  background: var(--color-accent);
  color: var(--color-bg);
}
.entry-author-badge.user {
  background: var(--color-border);
  color: var(--color-text-primary);
}
.entry-author-badge.small {
  padding: 0.125rem 0.25rem;
  font-size: 0;
}

.pin-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.entry-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding-top: 0.25rem;
}
.entry-tags.compact {
  padding-left: 1.5rem;
  padding-top: 0.125rem;
}

.entry-tag {
  font-size: 0.6875rem;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  color: var(--color-muted);
}
.entry-tag.small {
  font-size: 0.625rem;
  padding: 0 0.25rem;
}

/* Detail */
.entry-detail {
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.entry-body {
  line-height: 1.6;
}

/* Compose / Edit form */
.compose-form {
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.compose-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/* Search bar */
.search-bar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
</style>
