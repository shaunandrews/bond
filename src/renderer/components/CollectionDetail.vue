<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { PhTrash, PhStar, PhPlus, PhSortAscending, PhSortDescending, PhSlidersHorizontal } from '@phosphor-icons/vue'
import type { Collection, CollectionItem, FieldDef } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondTab from './BondTab.vue'
import CollectionItemDetail from './CollectionItemDetail.vue'

const props = defineProps<{
  collection: Collection
}>()

const items = ref<CollectionItem[]>([])
const loading = ref(true)
const addingItem = ref(false)
const newItemData = ref<Record<string, string>>({})
const selectedItemId = ref<string | null>(null)

// Sorting
const sortField = ref<string | null>(null)
const sortAsc = ref(true)

// Grouping
const groupByField = ref<string | null>(null)
const viewMode = ref<'table' | 'list' | 'cards'>('table')

const schema = computed(() => props.collection.schema)
const primaryField = computed(() => schema.value.find(f => f.primary))
const columnOrder = ref<string[]>([])
const hiddenColumns = ref<string[]>([])
const columnMenuOpen = ref(false)
const draggedColumn = ref<string | null>(null)
const nonPrimaryFields = computed(() => schema.value.filter(f => !f.primary))
const orderedFields = computed(() => {
  const byName = new Map(nonPrimaryFields.value.map(field => [field.name, field]))
  const ordered = columnOrder.value.map(name => byName.get(name)).filter((field): field is FieldDef => !!field)
  return [...ordered, ...nonPrimaryFields.value.filter(field => !columnOrder.value.includes(field.name))]
})
const visibleFields = computed(() => orderedFields.value.filter(field => !hiddenColumns.value.includes(field.name)))
const selectFields = computed(() => schema.value.filter(f => f.type === 'select'))

function openExternalLink(url: string) {
  void window.bond.openExternal(url)
}

function itemReference(item: CollectionItem): string | null {
  return props.collection.issuePrefix ? `${props.collection.issuePrefix}-${item.displayNumber}` : null
}

const sortedItems = computed(() => {
  let list = [...items.value]
  if (sortField.value) {
    const field = schema.value.find(f => f.name === sortField.value)
    if (field) {
      list.sort((a, b) => {
        const av = a.data[field.name]
        const bv = b.data[field.name]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        let cmp = 0
        if (field.type === 'number' || field.type === 'rating') {
          cmp = (av as number) - (bv as number)
        } else if (field.type === 'date') {
          cmp = String(av).localeCompare(String(bv))
        } else if (field.type === 'boolean') {
          cmp = (av ? 1 : 0) - (bv ? 1 : 0)
        } else if (field.type === 'select' && field.options) {
          cmp = field.options.indexOf(String(av)) - field.options.indexOf(String(bv))
        } else {
          cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
        }
        return sortAsc.value ? cmp : -cmp
      })
    }
  }
  return list
})

interface GroupedItems {
  label: string
  items: CollectionItem[]
}

const groupedItems = computed((): GroupedItems[] => {
  if (!groupByField.value) return [{ label: '', items: sortedItems.value }]
  const field = schema.value.find(f => f.name === groupByField.value)
  if (!field || field.type !== 'select' || !field.options) return [{ label: '', items: sortedItems.value }]
  const groups: GroupedItems[] = field.options.map(opt => ({
    label: opt,
    items: sortedItems.value.filter(i => i.data[field.name] === opt)
  }))
  const ungrouped = sortedItems.value.filter(i => {
    const val = i.data[field.name]
    return val == null || !field.options!.includes(String(val))
  })
  if (ungrouped.length) groups.push({ label: 'Other', items: ungrouped })
  return groups.filter(g => g.items.length > 0)
})

function toggleSort(fieldName: string) {
  if (sortField.value === fieldName) {
    if (sortAsc.value) { sortAsc.value = false }
    else { sortField.value = null; sortAsc.value = true }
  } else {
    sortField.value = fieldName
    sortAsc.value = true
  }
}

function toggleGroup(fieldName: string) {
  groupByField.value = groupByField.value === fieldName ? null : fieldName
}

function setViewMode(value: string) {
  if (value === 'table' || value === 'list' || value === 'cards') viewMode.value = value
}

function collectionSettingsKey() {
  // Retains the existing key so saved column layouts upgrade in place.
  return `bond:collection-columns:${props.collection.id}`
}

type CollectionViewSettings = {
  order?: string[]
  hidden?: string[]
  viewMode?: 'table' | 'list' | 'cards'
  groupByField?: string | null
  sortField?: string | null
  sortAsc?: boolean
}

function loadCollectionSettings() {
  const fields = nonPrimaryFields.value.map(field => field.name)
  const schemaFields = schema.value.map(field => field.name)
  const groupFields = selectFields.value.map(field => field.name)
  try {
    const saved = JSON.parse(localStorage.getItem(collectionSettingsKey()) ?? '{}') as CollectionViewSettings
    columnOrder.value = [...(saved.order ?? []).filter(name => fields.includes(name)), ...fields.filter(name => !(saved.order ?? []).includes(name))]
    hiddenColumns.value = (saved.hidden ?? []).filter(name => fields.includes(name))
    if (saved.viewMode && ['table', 'list', 'cards'].includes(saved.viewMode)) viewMode.value = saved.viewMode
    if (saved.sortField && schemaFields.includes(saved.sortField)) sortField.value = saved.sortField
    if (typeof saved.sortAsc === 'boolean') sortAsc.value = saved.sortAsc
    if (saved.groupByField && groupFields.includes(saved.groupByField)) groupByField.value = saved.groupByField
  } catch {
    columnOrder.value = fields
    hiddenColumns.value = []
  }
}

function saveCollectionSettings() {
  try {
    const settings: CollectionViewSettings = {
      order: columnOrder.value,
      hidden: hiddenColumns.value,
      viewMode: viewMode.value,
      groupByField: groupByField.value,
      sortField: sortField.value,
      sortAsc: sortAsc.value,
    }
    localStorage.setItem(collectionSettingsKey(), JSON.stringify(settings))
  } catch { /* local storage may be unavailable */ }
}

watch([viewMode, groupByField, sortField, sortAsc], saveCollectionSettings)

function toggleColumn(fieldName: string) {
  hiddenColumns.value = hiddenColumns.value.includes(fieldName)
    ? hiddenColumns.value.filter(name => name !== fieldName)
    : [...hiddenColumns.value, fieldName]
  saveCollectionSettings()
}

function dropColumn(target: string) {
  const source = draggedColumn.value
  if (!source || source === target) return
  const next = columnOrder.value.filter(name => name !== source)
  next.splice(next.indexOf(target), 0, source)
  columnOrder.value = next
  draggedColumn.value = null
  saveCollectionSettings()
}

async function refresh() {
  items.value = await window.bond.listCollectionItems(props.collection.id)
}

let unsub: (() => void) | null = null

onMounted(async () => {
  loadCollectionSettings()
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

function getItemLabel(item: CollectionItem): string {
  if (primaryField.value) {
    const val = item.data[primaryField.value.name]
    if (val != null) return String(val)
  }
  return item.id.slice(0, 8)
}

async function deleteItem(id: string) {
  await window.bond.deleteCollectionItem(id)
}

async function submitNewItem() {
  const data: Record<string, unknown> = {}
  for (const field of schema.value) {
    const raw = newItemData.value[field.name]
    if (raw == null || raw === '') continue
    data[field.name] = parseValue(raw, field)
  }
  if (Object.keys(data).length === 0) return
  await window.bond.addCollectionItem(props.collection.id, data)
  newItemData.value = {}
  addingItem.value = false
}

function parseValue(raw: string, field: FieldDef): unknown {
  switch (field.type) {
    case 'number':
    case 'rating':
      return Number(raw)
    case 'boolean':
      return raw === 'true' || raw === 'yes' || raw === '1'
    case 'multiselect':
    case 'tags':
      return raw.split(',').map(s => s.trim())
    default:
      return raw
  }
}

async function toggleBoolean(item: CollectionItem, fieldName: string) {
  const current = item.data[fieldName]
  await window.bond.updateCollectionItem(item.id, { [fieldName]: !current })
}

function formatValue(value: unknown, field: FieldDef): string {
  if (value == null) return ''
  switch (field.type) {
    case 'number': return `${field.prefix ?? ''}${value}${field.suffix ?? ''}`
    case 'boolean': return value ? 'Yes' : 'No'
    default: return Array.isArray(value) ? value.join(', ') : String(value)
  }
}
</script>

<template>
  <div class="collection-detail">
    <!-- Item detail view -->
    <CollectionItemDetail
      v-if="selectedItemId"
      :collection="collection"
      :itemId="selectedItemId"
      @back="selectedItemId = null"
      @deleted="selectedItemId = null"
    />

    <div v-else-if="loading" class="detail-loading">
      <BondText size="sm" color="muted">Loading items...</BondText>
    </div>

    <template v-else>
      <!-- View and grouping controls -->
      <div class="detail-toolbar">
        <BondTab
          :tabs="[{ id: 'table', label: 'Table' }, { id: 'list', label: 'List' }, { id: 'cards', label: 'Cards' }]"
          size="sm"
          :model-value="viewMode"
          @update:model-value="setViewMode"
        />
        <div class="detail-toolbar-spacer" />
        <div class="view-settings-control">
          <BondButton variant="ghost" size="sm" icon :aria-expanded="columnMenuOpen" @click="columnMenuOpen = !columnMenuOpen" v-tooltip="'View settings'">
            <PhSlidersHorizontal :size="16" weight="bold" />
          </BondButton>
          <div v-if="columnMenuOpen" class="view-settings-menu">
            <template v-if="selectFields.length">
              <BondText as="div" size="xs" weight="medium" color="muted" class="view-settings-label">Group by</BondText>
              <BondButton
                v-for="f in selectFields"
                :key="f.name"
                variant="secondary"
                size="sm"
                class="group-chip"
                :class="{ active: groupByField === f.name }"
                @click="toggleGroup(f.name)"
              >
                {{ f.name }}
              </BondButton>
            </template>
            <BondText as="div" size="xs" weight="medium" color="muted" class="view-settings-label">Columns</BondText>
            <BondText as="div" size="xs" color="muted" class="view-settings-hint">Drag to reorder · toggle visibility</BondText>
            <label
              v-for="field in orderedFields"
              :key="field.name"
              class="column-option"
              draggable="true"
              @dragstart="draggedColumn = field.name"
              @dragover.prevent
              @drop.prevent="dropColumn(field.name)"
            >
              <input type="checkbox" :checked="!hiddenColumns.includes(field.name)" @change="toggleColumn(field.name)" />
              <span class="column-grip" aria-hidden="true">⠿</span>
              <span>{{ field.name }}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="items.length === 0" class="detail-empty">
        <BondText size="sm" color="muted">No items yet.</BondText>
        <BondButton variant="primary" size="sm" @click="addingItem = true">
          <PhPlus :size="14" weight="bold" />
          Add item
        </BondButton>
      </div>

      <!-- Items table -->
      <template v-else>
        <div v-for="group in groupedItems" :key="group.label" class="item-group">
          <BondText v-if="group.label" as="div" size="xs" weight="semibold" color="muted" class="group-header">
            {{ group.label }} ({{ group.items.length }})
          </BondText>

          <div v-if="viewMode === 'table'" class="items-table">
            <!-- Header -->
            <div class="table-header">
              <div
                v-if="primaryField"
                class="th th-primary"
                @click="toggleSort(primaryField!.name)"
              >
                {{ primaryField!.name }}
                <PhSortAscending v-if="sortField === primaryField!.name && sortAsc" :size="12" />
                <PhSortDescending v-else-if="sortField === primaryField!.name && !sortAsc" :size="12" />
              </div>
              <div
                v-for="f in visibleFields"
                :key="f.name"
                class="th"
                @click="toggleSort(f.name)"
              >
                {{ f.name }}
                <PhSortAscending v-if="sortField === f.name && sortAsc" :size="12" />
                <PhSortDescending v-else-if="sortField === f.name && !sortAsc" :size="12" />
              </div>
              <div class="th th-actions" />
            </div>

            <!-- Rows -->
            <div v-for="item in group.items" :key="item.id" class="table-row" @click="selectedItemId = item.id">
              <div v-if="primaryField" class="td td-primary">
                <span v-if="itemReference(item)" class="item-reference">{{ itemReference(item) }}</span>
                {{ getItemLabel(item) }}
              </div>
              <div v-for="f in visibleFields" :key="f.name" class="td">
                <template v-if="f.type === 'rating'">
                  <span class="rating">
                    <template v-for="n in (f.max ?? 5)" :key="n">
                      <PhStar v-if="n <= (item.data[f.name] as number ?? 0)" :size="12" weight="fill" class="star--filled" />
                      <PhStar v-else :size="12" class="star--empty" />
                    </template>
                  </span>
                </template>
                <template v-else-if="f.type === 'boolean'">
                  <button class="bool-toggle" @click.stop="toggleBoolean(item, f.name)">
                    {{ item.data[f.name] ? '✓' : '—' }}
                  </button>
                </template>
                <template v-else-if="f.type === 'select'">
                  <span class="field-badge">{{ item.data[f.name] ?? '' }}</span>
                </template>
                <template v-else-if="f.type === 'url' && item.data[f.name]">
                  <a class="field-link" @click.prevent.stop="openExternalLink(String(item.data[f.name]))">link</a>
                </template>
                <template v-else>
                  {{ formatValue(item.data[f.name], f) }}
                </template>
              </div>
              <div class="td td-actions">
                <BondButton variant="ghost" size="sm" icon @click.stop="deleteItem(item.id)" v-tooltip="'Delete'">
                  <PhTrash :size="12" />
                </BondButton>
              </div>
            </div>
          </div>

          <div v-else-if="viewMode === 'list'" class="items-list">
            <button v-for="item in group.items" :key="item.id" class="list-item" @click="selectedItemId = item.id">
              <div class="list-item-title"><span v-if="itemReference(item)" class="item-reference">{{ itemReference(item) }}</span>{{ getItemLabel(item) }}</div>
              <div class="list-item-meta"><span v-for="f in visibleFields.filter(f => item.data[f.name] != null).slice(0, 3)" :key="f.name">{{ f.name }}: {{ formatValue(item.data[f.name], f) }}</span></div>
            </button>
          </div>

          <div v-else class="items-cards">
            <button v-for="item in group.items" :key="item.id" class="item-card" @click="selectedItemId = item.id">
              <div class="list-item-title"><span v-if="itemReference(item)" class="item-reference">{{ itemReference(item) }}</span>{{ getItemLabel(item) }}</div>
              <div class="card-details">{{ visibleFields.map(f => formatValue(item.data[f.name], f)).filter(Boolean).join(' · ') }}</div>
            </button>
          </div>
        </div>

        <BondButton v-if="!addingItem" variant="ghost" size="sm" class="add-btn" @click="addingItem = true">
          <PhPlus :size="14" weight="bold" />
          Add item
        </BondButton>
      </template>

      <!-- Add item form -->
      <div v-if="addingItem" class="add-form">
        <BondText as="div" size="xs" weight="semibold" color="muted" class="add-form-title">New item</BondText>
        <div v-for="f in schema" :key="f.name" class="add-field">
          <label class="add-label">{{ f.name }}</label>
          <select
            v-if="f.type === 'select' && f.options"
            :value="newItemData[f.name] ?? ''"
            class="add-input"
            @change="newItemData[f.name] = ($event.target as HTMLSelectElement).value"
          >
            <option value="">—</option>
            <option v-for="opt in f.options" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <input
            v-else
            :type="f.type === 'number' || f.type === 'rating' ? 'number' : f.type === 'date' ? 'date' : 'text'"
            :value="newItemData[f.name] ?? ''"
            :placeholder="f.name"
            class="add-input"
            @input="newItemData[f.name] = ($event.target as HTMLInputElement).value"
            @keydown.enter="submitNewItem"
          />
        </div>
        <div class="add-actions">
          <BondButton variant="ghost" size="sm" @click="addingItem = false; newItemData = {}">Cancel</BondButton>
          <BondButton variant="primary" size="sm" @click="submitNewItem">Add</BondButton>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.collection-detail {
  padding: 1rem 1.5rem 2rem;
}

.detail-loading, .detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 4rem 1rem;
}

.detail-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.detail-toolbar-spacer { flex: 1; }
.view-settings-control { position: relative; }
.view-settings-menu {
  position: absolute;
  z-index: 5;
  top: calc(100% + 5px);
  right: 0;
  min-width: 210px;
  padding: 0.45rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}
.view-settings-label { padding: 0.3rem 0.35rem 0.25rem; }
.view-settings-hint { padding: 0 0.35rem 0.35rem; }
.view-settings-menu .group-chip { margin: 0 0.2rem 0.45rem 0; }
.column-option { display: flex; align-items: center; gap: 0.45rem; padding: 0.35rem; border-radius: var(--radius-sm); color: var(--color-text-primary); font-size: 0.78rem; cursor: grab; }
.column-option:hover { background: var(--color-tint); }
.column-grip { color: var(--color-muted); font-size: 0.9rem; letter-spacing: -0.2em; }
.item-reference {
  display: inline-block;
  margin-right: 0.45rem;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: 0.78em;
  font-weight: 500;
}

.group-chip.active {
  background: var(--color-accent);
  color: white;
  box-shadow: none;
}

.item-group + .item-group {
  margin-top: 1.5rem;
}

.group-header {
  margin-bottom: 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.items-table {
  width: 100%;
}
.items-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
}
.list-item {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  width: 100%;
  padding: 0.8rem 0.15rem;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.list-item:hover { background: var(--color-tint); }
.list-item-title { min-width: 0; font-weight: 550; }
.list-item-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.65rem; color: var(--color-muted); font-size: 0.78rem; }
.items-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 0.75rem;
}
.item-card {
  min-height: 112px;
  padding: 0.9rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item-card:hover { border-color: var(--color-accent); }
.card-details { margin-top: 0.45rem; color: var(--color-muted); font-size: 0.8rem; line-height: 1.45; }

.table-header {
  display: flex;
  gap: 0.5rem;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.4rem;
  margin-bottom: 0.25rem;
}

.th {
  flex: 1;
  min-width: 0;
  font-size: 0.7rem;
  color: var(--color-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  user-select: none;
  transition: color var(--transition-fast);
}
.th:hover {
  color: var(--color-text-primary);
}

.th-primary {
  flex: 2;
}

.th-actions {
  flex: 0 0 2rem;
  cursor: default;
}

.table-row {
  display: flex;
  gap: 0.5rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
  align-items: center;
  font-size: 0.8125rem;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}
.table-row:hover {
  background: var(--color-tint);
}
.table-row:last-child {
  border-bottom: none;
}

.td {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-primary {
  flex: 2;
  font-weight: 500;
}

.td-actions {
  flex: 0 0 2rem;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.table-row:hover .td-actions {
  opacity: 1;
}

.rating {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.star--filled {
  color: var(--color-accent);
}

.star--empty {
  color: var(--color-muted);
  opacity: 0.3;
}

.field-badge {
  font-size: 0.7rem;
  color: var(--color-muted);
  background: var(--color-tint);
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
}

.field-link {
  color: var(--color-accent);
  font-size: 0.8rem;
  cursor: pointer;
  text-decoration: underline;
}

.bool-toggle {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-muted);
  font-size: 0.8rem;
  padding: 0;
}

.add-btn {
  margin-top: 0.75rem;
}

.add-form {
  margin-top: 1rem;
  padding: 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.add-form-title {
  margin-bottom: 0.25rem;
}

.add-field {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.add-label {
  font-size: 0.75rem;
  color: var(--color-muted);
  width: 6rem;
  flex-shrink: 0;
  text-align: right;
}

.add-input {
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
.add-input:focus {
  border-color: var(--color-accent);
}

.add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
