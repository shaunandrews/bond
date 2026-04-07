<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { PhArrowLeft, PhStar, PhTrash, PhPencilSimple, PhCheck, PhX, PhPaperPlaneTilt } from '@phosphor-icons/vue'
import type { Collection, CollectionItem, FieldDef, ItemComment } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'

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
const editData = ref<Record<string, string>>({})
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
  editData.value = {}
  for (const field of schema.value) {
    const val = item.value.data[field.name]
    if (val != null) {
      editData.value[field.name] = Array.isArray(val) ? val.join(', ') : String(val)
    } else {
      editData.value[field.name] = ''
    }
  }
}

function cancelEditing() {
  editing.value = false
  editData.value = {}
}

function parseValue(raw: string, field: FieldDef): unknown {
  if (raw === '') return undefined
  switch (field.type) {
    case 'number':
    case 'rating':
      return Number(raw)
    case 'boolean':
      return raw === 'true' || raw === 'yes' || raw === '1'
    case 'multiselect':
    case 'tags':
      return raw.split(',').map(s => s.trim()).filter(Boolean)
    default:
      return raw
  }
}

async function saveEdit() {
  if (!item.value) return
  const data: Record<string, unknown> = {}
  for (const field of schema.value) {
    const raw = editData.value[field.name]
    if (raw == null) continue
    const parsed = parseValue(raw, field)
    if (parsed !== undefined) {
      data[field.name] = parsed
    }
  }
  await window.bond.updateCollectionItem(item.value.id, data)
  editing.value = false
  editData.value = {}
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

function formatValue(value: unknown, field: FieldDef): string {
  if (value == null) return '—'
  switch (field.type) {
    case 'number': return `${field.prefix ?? ''}${value}${field.suffix ?? ''}`
    case 'boolean': return value ? 'Yes' : 'No'
    case 'date': return String(value)
    default: return Array.isArray(value) ? value.join(', ') : String(value)
  }
}

function formatCommentDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function isLongContent(value: unknown, field: FieldDef): boolean {
  return field.type === 'longtext' || (field.type === 'text' && String(value ?? '').length > 80)
}

function openUrl(url: string) {
  window.bond.openExternal(url)
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
            <select
              v-if="field.type === 'select' && field.options"
              :value="editData[field.name] ?? ''"
              class="field-input"
              @change="editData[field.name] = ($event.target as HTMLSelectElement).value"
            >
              <option value="">—</option>
              <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <textarea
              v-else-if="field.type === 'longtext'"
              :value="editData[field.name] ?? ''"
              class="field-input field-textarea"
              rows="4"
              @input="editData[field.name] = ($event.target as HTMLTextAreaElement).value"
            />
            <input
              v-else
              :type="field.type === 'number' || field.type === 'rating' ? 'number' : field.type === 'date' ? 'date' : 'text'"
              :value="editData[field.name] ?? ''"
              class="field-input"
              @input="editData[field.name] = ($event.target as HTMLInputElement).value"
            />
          </template>

          <!-- Display mode -->
          <template v-else>
            <div v-if="field.type === 'rating'" class="field-value">
              <span class="rating">
                <template v-for="n in (field.max ?? 5)" :key="n">
                  <PhStar v-if="n <= (item.data[field.name] as number ?? 0)" :size="14" weight="fill" class="star--filled" />
                  <PhStar v-else :size="14" class="star--empty" />
                </template>
              </span>
            </div>
            <div v-else-if="field.type === 'url' && item.data[field.name]" class="field-value">
              <a class="value-link" @click.prevent="openUrl(String(item.data[field.name]))">
                {{ String(item.data[field.name]) }}
              </a>
            </div>
            <div v-else-if="field.type === 'select'" class="field-value">
              <span v-if="item.data[field.name]" class="value-badge">{{ item.data[field.name] }}</span>
              <span v-else class="value-empty">—</span>
            </div>
            <div v-else-if="field.type === 'tags' || field.type === 'multiselect'" class="field-value">
              <template v-if="Array.isArray(item.data[field.name]) && (item.data[field.name] as unknown[]).length">
                <span v-for="tag in (item.data[field.name] as string[])" :key="tag" class="value-tag">{{ tag }}</span>
              </template>
              <span v-else class="value-empty">—</span>
            </div>
            <div v-else-if="isLongContent(item.data[field.name], field)" class="field-value field-value--long">
              {{ item.data[field.name] ?? '—' }}
            </div>
            <div v-else class="field-value">
              {{ formatValue(item.data[field.name], field) }}
            </div>
          </template>
        </div>
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

.value-empty {
  color: var(--color-muted);
}

.value-link {
  color: var(--color-accent);
  cursor: pointer;
  text-decoration: underline;
  word-break: break-all;
}

.value-badge {
  font-size: 0.75rem;
  color: var(--color-muted);
  background: var(--color-tint);
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
}

.value-tag {
  display: inline-block;
  font-size: 0.7rem;
  color: var(--color-muted);
  background: var(--color-tint);
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
  margin-right: 0.25rem;
}

.rating {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.star--filled {
  color: var(--color-accent);
}

.star--empty {
  color: var(--color-muted);
  opacity: 0.3;
}

/* Edit inputs */
.field-input {
  flex: 1;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0.3rem 0.5rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  outline: none;
  transition: border-color var(--transition-fast);
}
.field-input:focus {
  border-color: var(--color-accent);
}

.field-textarea {
  resize: vertical;
  min-height: 4rem;
  line-height: 1.5;
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
