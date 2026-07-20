<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { PhArrowLeft, PhTrash, PhPencilSimple, PhCheck, PhX, PhPaperPlaneTilt } from '@phosphor-icons/vue'
import type { Collection, CollectionItem, FieldDef, ItemComment } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import FieldValue from './fields/FieldValue.vue'
import FieldEditor from './fields/FieldEditor.vue'

const props = defineProps<{
  collection: Collection
  itemId: string
}>()

const emit = defineEmits<{
  back: []
  deleted: []
}>()

const item = ref<CollectionItem | null>(null)
const loading = ref(true)
const editing = ref(false)
// Canonical values straight from FieldEditor — sent to the daemon unparsed.
const editData = ref<Record<string, unknown>>({})
const editError = ref<string | null>(null)
const commentText = ref('')
const commentInputRef = ref<HTMLTextAreaElement | null>(null)

const schema = computed(() => props.collection.schema)
const primaryField = computed(() => schema.value.find(f => f.primary))
const otherFields = computed(() => schema.value.filter(f => !f.primary))

const itemLabel = computed(() => {
  if (!item.value || !primaryField.value) return ''
  const val = item.value.data[primaryField.value.name]
  return val != null ? String(val) : item.value.id.slice(0, 8)
})

/** Tracker key (e.g. BOND-12) when the collection has an issue prefix. */
const itemKey = computed(() => {
  if (!item.value || !props.collection.issuePrefix) return null
  return `${props.collection.issuePrefix}-${item.value.displayNumber}`
})

const comments = computed(() => item.value?.comments ?? [])

async function refresh() {
  item.value = await window.bond.getCollectionItem(props.itemId)
}

let unsub: (() => void) | null = null

onMounted(async () => {
  try {
    await refresh()
  } finally {
    loading.value = false
  }
  unsub = window.bond.onCollectionsChanged(() => refresh())
})

onUnmounted(() => {
  unsub?.()
})

function startEditing() {
  if (!item.value) return
  editing.value = true
  editError.value = null
  editData.value = {}
  for (const field of schema.value) {
    const val = item.value.data[field.name]
    if (val !== undefined && val !== null) editData.value[field.name] = val
  }
}

function cancelEditing() {
  editing.value = false
  editData.value = {}
  editError.value = null
}

async function saveEdit() {
  if (!item.value) return
  const data: Record<string, unknown> = {}
  for (const field of schema.value) {
    const value = editData.value[field.name]
    if (value === undefined || value === '') {
      // Explicit null clears a previously set field on the daemon
      if (item.value.data[field.name] != null) data[field.name] = null
      continue
    }
    data[field.name] = value
  }
  try {
    await window.bond.updateCollectionItem(item.value.id, data)
    editing.value = false
    editData.value = {}
    editError.value = null
  } catch (e) {
    // The daemon names the offending field and its allowed values
    editError.value = e instanceof Error ? e.message : String(e)
  }
}

async function deleteItem() {
  if (!item.value) return
  await window.bond.deleteCollectionItem(item.value.id)
  emit('deleted')
}

async function submitComment() {
  if (!item.value || !commentText.value.trim()) return
  await window.bond.addItemComment(item.value.id, 'user', commentText.value.trim())
  commentText.value = ''
  await refresh()
}

function formatCommentDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function isLongContent(value: unknown, field: FieldDef): boolean {
  return field.type === 'longtext' || (field.type === 'text' && String(value ?? '').length > 80)
}

function handleCommentKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitComment()
  }
}
</script>

<template>
  <div class="item-detail">
    <div v-if="loading" class="item-detail-loading">
      <BondText size="sm" color="muted">Loading...</BondText>
    </div>

    <div v-else-if="!item" class="item-detail-loading">
      <BondText size="sm" color="muted">Item not found</BondText>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="item-header">
        <BondButton variant="ghost" size="sm" icon @click="emit('back')" v-tooltip="'Back'">
          <PhArrowLeft :size="16" weight="bold" />
        </BondButton>
        <div class="item-header-title">
          <span v-if="itemKey" class="item-key">{{ itemKey }}</span>
          <BondText size="lg" weight="semibold">{{ itemLabel }}</BondText>
        </div>
        <div class="item-header-actions">
          <BondButton v-if="!editing" variant="ghost" size="sm" icon @click="startEditing" v-tooltip="'Edit'">
            <PhPencilSimple :size="16" weight="bold" />
          </BondButton>
          <template v-if="editing">
            <BondButton variant="ghost" size="sm" icon @click="cancelEditing" v-tooltip="'Cancel'">
              <PhX :size="16" weight="bold" />
            </BondButton>
            <BondButton variant="primary" size="sm" icon @click="saveEdit" v-tooltip="'Save'">
              <PhCheck :size="16" weight="bold" />
            </BondButton>
          </template>
          <BondButton variant="ghost" size="sm" icon @click="deleteItem" v-tooltip="'Delete'">
            <PhTrash :size="16" weight="bold" />
          </BondButton>
        </div>
      </div>

      <!-- Fields -->
      <div class="item-fields">
        <div v-for="field in otherFields" :key="field.name" class="field-row" :class="{ 'field-row--long': !editing && isLongContent(item.data[field.name], field) }">
          <label class="field-label">{{ field.name }}</label>

          <!-- Edit mode -->
          <template v-if="editing">
            <FieldEditor
              :def="field"
              :model-value="editData[field.name]"
              @update:model-value="editData[field.name] = $event"
            />
          </template>

          <!-- Display mode -->
          <template v-else>
            <div v-if="isLongContent(item.data[field.name], field)" class="field-value field-value--long">
              {{ item.data[field.name] ?? '—' }}
            </div>
            <div v-else class="field-value">
              <FieldValue :value="item.data[field.name]" :def="field" />
            </div>
          </template>
        </div>
        <BondText v-if="editing && editError" as="div" size="xs" color="err" class="edit-error">{{ editError }}</BondText>
      </div>

      <!-- Timestamps -->
      <div class="item-meta">
        <BondText size="xs" color="muted">
          Added {{ new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }}
        </BondText>
        <BondText v-if="item.updatedAt !== item.createdAt" size="xs" color="muted">
          · Updated {{ new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }}
        </BondText>
      </div>

      <!-- Comments -->
      <div class="item-comments">
        <BondText as="div" size="xs" weight="semibold" color="muted" class="comments-label">
          Comments ({{ comments.length }})
        </BondText>

        <div v-if="comments.length" class="comments-list">
          <div v-for="c in comments" :key="c.id" class="comment">
            <div class="comment-header">
              <span class="comment-author" :class="{ 'comment-author--bond': c.author === 'bond' }">
                {{ c.author === 'bond' ? 'Bond' : 'You' }}
              </span>
              <span class="comment-date">{{ formatCommentDate(c.createdAt) }}</span>
            </div>
            <div class="comment-body">{{ c.body }}</div>
          </div>
        </div>

        <div class="comment-input-wrap">
          <textarea
            ref="commentInputRef"
            v-model="commentText"
            class="comment-input"
            placeholder="Add a comment..."
            rows="1"
            @keydown="handleCommentKeydown"
          />
          <BondButton
            v-if="commentText.trim()"
            variant="primary"
            size="sm"
            icon
            class="comment-send"
            @click="submitComment"
          >
            <PhPaperPlaneTilt :size="14" weight="bold" />
          </BondButton>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.item-detail {
  padding: 0.75rem 1.5rem 2rem;
}

.item-detail-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem 1rem;
}

/* Header */
.item-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.item-header-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.item-key {
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 500;
  flex-shrink: 0;
}

.item-header-actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

/* Fields */
.item-fields {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.field-row {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
}

.field-row--long {
  flex-direction: column;
  gap: 0.35rem;
}

.field-label {
  flex-shrink: 0;
  width: 7rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.field-row--long .field-label {
  width: auto;
}

.field-value {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.field-value--long {
  white-space: pre-wrap;
  line-height: 1.55;
}

.edit-error {
  padding: 0.25rem 0;
}

/* Meta */
.item-meta {
  display: flex;
  gap: 0.25rem;
  margin-top: 1.25rem;
  padding-top: 0.75rem;
}

/* Comments */
.item-comments {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
}

.comments-label {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
}

.comments-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.comment {
  padding: 0.5rem 0.75rem;
  background: var(--color-surface);
  border-radius: var(--radius-md);
}

.comment-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.comment-author {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.comment-author--bond {
  color: var(--color-accent);
}

.comment-date {
  font-size: 0.7rem;
  color: var(--color-muted);
}

.comment-body {
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
}

.comment-input-wrap {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

.comment-input {
  flex: 1;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  outline: none;
  resize: none;
  min-height: 2rem;
  transition: border-color var(--transition-fast);
}
.comment-input:focus {
  border-color: var(--color-accent);
}

.comment-send {
  flex-shrink: 0;
}
</style>
