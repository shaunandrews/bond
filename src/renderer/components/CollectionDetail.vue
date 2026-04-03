<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { PhTrash, PhStar, PhPlus, PhSortAscending, PhSortDescending } from '@phosphor-icons/vue'
import type { Collection, CollectionItem, FieldDef } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'

const props = defineProps<{
  collection: Collection
}>()

const items = ref<CollectionItem[]>([])
const loading = ref(true)
const addingItem = ref(false)
const newItemData = ref<Record<string, string>>({})

// Sorting
const sortField = ref<string | null>(null)
const sortAsc = ref(true)

// Grouping
const groupByField = ref<string | null>(null)

const schema = computed(() => props.collection.schema)
const primaryField = computed(() => schema.value.find(f => f.primary))
const visibleFields = computed(() => schema.value.filter(f => !f.primary))
const selectFields = computed(() => schema.value.filter(f => f.type === 'select'))

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

async function refresh() {
  items.value = await window.bond.listCollectionItems(props.collection.id)
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
    <div v-if="loading" class="detail-loading">
      <BondText size="sm" color="muted">Loading items...</BondText>
    </div>

    <template v-else>
      <!-- Toolbar: group by -->
      <div v-if="selectFields.length" class="detail-toolbar">
        <BondText size="xs" color="muted">Group by:</BondText>
        <button
          v-for="f in selectFields"
          :key="f.name"
          class="group-chip"
          :class="{ active: groupByField === f.name }"
          @click="toggleGroup(f.name)"
        >
          {{ f.name }}
        </button>
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

          <div class="items-table">
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
            <div v-for="item in group.items" :key="item.id" class="table-row">
              <div v-if="primaryField" class="td td-primary">
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
                  <button class="bool-toggle" @click="toggleBoolean(item, f.name)">
                    {{ item.data[f.name] ? '✓' : '—' }}
                  </button>
                </template>
                <template v-else-if="f.type === 'select'">
                  <span class="field-badge">{{ item.data[f.name] ?? '' }}</span>
                </template>
                <template v-else-if="f.type === 'url' && item.data[f.name]">
                  <a class="field-link" @click.prevent="window.bond.openExternal(String(item.data[f.name]))">link</a>
                </template>
                <template v-else>
                  {{ formatValue(item.data[f.name], f) }}
                </template>
              </div>
              <div class="td td-actions">
                <BondButton variant="ghost" size="sm" icon @click="deleteItem(item.id)" v-tooltip="'Delete'">
                  <PhTrash :size="12" />
                </BondButton>
              </div>
            </div>
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
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.group-chip {
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: none;
  color: var(--color-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.group-chip:hover {
  border-color: var(--color-accent);
  color: var(--color-text-primary);
}
.group-chip.active {
  background: var(--color-accent);
  color: white;
  border-color: var(--color-accent);
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
