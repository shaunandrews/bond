<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import {
  PhArrowLeft, PhTrash, PhPencilSimple, PhCheck, PhX, PhPaperPlaneTilt,
  PhPlus, PhChatCircle, PhFolderOpen, PhLinkBreak,
  PhFileMd, PhFileText, PhFilePdf, PhFileHtml, PhFile,
} from '@phosphor-icons/vue'
import type { Collection, CollectionItem, FieldDef, ItemComment } from '../../shared/session'
import type { AttachedImage } from '../../shared/session'
import { imageDataUri } from '../../shared/session'
import type { AssetFormat, LibraryAsset } from '../../shared/library'
import { openLibraryAsset, revealLibraryAsset } from '../lib/library'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import FieldValue from './fields/FieldValue.vue'
import FieldEditor from './fields/FieldEditor.vue'

const FORMAT_ICON: Record<AssetFormat, unknown> = {
  markdown: PhFileMd,
  plaintext: PhFileText,
  pdf: PhFilePdf,
  html: PhFileHtml,
  other: PhFile,
  image: PhFile,
}

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

const references = ref<LibraryAsset[]>([])
const referenceImageData = ref<Map<string, AttachedImage>>(new Map())
const addReferenceOpen = ref(false)
const addRefButtonRef = ref<InstanceType<typeof BondButton> | null>(null)
const referenceSearch = ref('')
const libraryAssetsForPicker = ref<LibraryAsset[]>([])

const filteredPickerAssets = computed(() => {
  const referencedIds = new Set(references.value.map(a => a.id))
  const q = referenceSearch.value.trim().toLowerCase()
  return libraryAssetsForPicker.value
    .filter(a => !referencedIds.has(a.id))
    .filter(a => !q || a.title.toLowerCase().includes(q) || a.filename.toLowerCase().includes(q))
    .slice(0, 20)
})

async function loadReferences() {
  if (!item.value) return
  references.value = await window.bond.libraryListReferencesForItem(item.value.id)
  const media = references.value.filter(a => a.kind === 'media')
  if (!media.length) {
    referenceImageData.value = new Map()
    return
  }
  const images = await window.bond.getImages(media.map(a => a.id))
  const map = new Map<string, AttachedImage>()
  media.forEach((a, i) => { if (images[i]) map.set(a.id, images[i]!) })
  referenceImageData.value = map
}

async function openAddReference() {
  addReferenceOpen.value = true
  if (!libraryAssetsForPicker.value.length) {
    libraryAssetsForPicker.value = await window.bond.libraryList()
  }
}

async function addReference(asset: LibraryAsset) {
  if (!item.value) return
  await window.bond.libraryAddReference(asset.id, item.value.id)
  addReferenceOpen.value = false
  referenceSearch.value = ''
  await loadReferences()
}

async function removeReference(asset: LibraryAsset) {
  if (!item.value) return
  await window.bond.libraryRemoveReference(asset.id, item.value.id)
  await loadReferences()
}

function showInConversation(asset: LibraryAsset) {
  if (!asset.sourceMessageId) return
  window.dispatchEvent(new CustomEvent('bond:scroll-to-message', { detail: asset.sourceMessageId }))
}

async function refresh() {
  item.value = await window.bond.getCollectionItem(props.itemId)
  await loadReferences()
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

      <!-- References -->
      <div class="item-references">
        <BondText as="div" size="xs" weight="semibold" color="muted" class="comments-label">
          References ({{ references.length }})
        </BondText>

        <div v-if="references.length" class="reference-grid">
          <div v-for="asset in references" :key="asset.id" class="reference-tile" @dblclick="openLibraryAsset(asset)">
            <div class="reference-thumb">
              <img
                v-if="asset.kind === 'media' && referenceImageData.get(asset.id)"
                :src="imageDataUri(referenceImageData.get(asset.id)!)"
                :alt="asset.title"
                loading="lazy"
              />
              <div v-else-if="asset.kind === 'media'" class="reference-placeholder" />
              <div v-else class="reference-doc-preview">
                <component :is="FORMAT_ICON[asset.format]" :size="20" />
              </div>
              <div class="reference-meta">
                <BondText size="xs" truncate>{{ asset.title }}</BondText>
                <div class="reference-actions">
                  <BondButton
                    v-if="asset.sourceMessageId"
                    variant="ghost"
                    size="sm"
                    icon
                    @click.stop="showInConversation(asset)"
                    v-tooltip="'Show in conversation'"
                  >
                    <PhChatCircle :size="12" />
                  </BondButton>
                  <BondButton variant="ghost" size="sm" icon @click.stop="revealLibraryAsset(asset)" v-tooltip="'Reveal in Finder'">
                    <PhFolderOpen :size="12" />
                  </BondButton>
                  <BondButton variant="ghost" size="sm" icon @click.stop="removeReference(asset)" v-tooltip="'Remove reference'">
                    <PhLinkBreak :size="12" />
                  </BondButton>
                </div>
              </div>
            </div>
          </div>
        </div>

        <BondButton ref="addRefButtonRef" class="add-reference-btn" variant="ghost" size="sm" @click="openAddReference">
          <PhPlus :size="14" weight="bold" /> Add reference
        </BondButton>
        <BondFlyoutMenu :open="addReferenceOpen" :anchor="addRefButtonRef?.$el ?? null" @close="addReferenceOpen = false">
          <div class="reference-picker">
            <BondInput v-model="referenceSearch" placeholder="Search Library…" />
            <div class="reference-picker-list">
              <div
                v-for="asset in filteredPickerAssets"
                :key="asset.id"
                class="reference-picker-item"
                @click="addReference(asset)"
              >
                <component v-if="asset.kind === 'document'" :is="FORMAT_ICON[asset.format]" :size="14" />
                <BondText size="xs" truncate>{{ asset.title }}</BondText>
              </div>
              <BondText v-if="!filteredPickerAssets.length" size="xs" color="muted">No matches</BondText>
            </div>
          </div>
        </BondFlyoutMenu>
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

/* References */
.item-references {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
}

.reference-grid {
  columns: 120px;
  column-gap: 0.375rem;
  margin-bottom: 0.75rem;
}

.reference-tile {
  break-inside: avoid;
  margin-bottom: 0.375rem;
  cursor: pointer;
}

.reference-thumb {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  min-height: 4.5rem;
}

.reference-thumb img {
  width: 100%;
  display: block;
}

.reference-placeholder {
  width: 100%;
  height: 100%;
  background: var(--color-surface);
}

.reference-doc-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  min-height: 4.5rem;
  color: var(--color-muted);
}

.reference-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0.375rem;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  color: rgba(255, 255, 255, 0.9);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.reference-tile:hover .reference-meta {
  opacity: 1;
}

.reference-actions {
  display: flex;
  gap: 0.125rem;
  flex-shrink: 0;
}

.reference-picker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 16rem;
}

.reference-picker-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  max-height: 14rem;
  overflow-y: auto;
}

.reference-picker-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.reference-picker-item:hover {
  background: var(--color-surface);
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
