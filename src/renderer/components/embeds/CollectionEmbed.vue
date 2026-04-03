<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { PhStar } from '@phosphor-icons/vue'
import type { Collection, CollectionItem, FieldDef } from '../../../shared/session'

const props = defineProps<{
  name?: string
  filter?: string       // "field=value"
  search?: string       // text search across primary field
  ids?: string          // comma-separated item IDs
  limit?: string        // max items
}>()

const collections = ref<Collection[]>([])
const items = ref<CollectionItem[]>([])
const loading = ref(true)

const targetCollection = computed(() => {
  if (!props.name) return null
  return collections.value.find(
    c => c.name.toLowerCase() === props.name!.toLowerCase()
  ) ?? null
})

const showOverview = computed(() => !props.name)

const filteredItems = computed(() => {
  if (!targetCollection.value) return []
  let list = items.value

  // ID filter
  if (props.ids) {
    const idSet = new Set(props.ids.split(',').map(s => s.trim()).filter(Boolean))
    const map = new Map(list.map(i => [i.id, i]))
    list = [...idSet].map(id => map.get(id)).filter(Boolean) as CollectionItem[]
  }

  // Text search across primary field
  if (props.search) {
    const q = props.search.toLowerCase()
    const primary = targetCollection.value.schema.find(f => f.primary)
    if (primary) {
      list = list.filter(i => {
        const val = i.data[primary.name]
        return val != null && String(val).toLowerCase().includes(q)
      })
    }
  }

  // Field=value filter
  if (props.filter) {
    const eq = props.filter.indexOf('=')
    if (eq !== -1) {
      const field = props.filter.slice(0, eq).trim()
      const val = props.filter.slice(eq + 1).trim().toLowerCase()
      list = list.filter(i => {
        const itemVal = i.data[field]
        return itemVal != null && String(itemVal).toLowerCase() === val
      })
    }
  }

  // Limit
  if (props.limit) {
    const n = parseInt(props.limit, 10)
    if (!isNaN(n) && n > 0) list = list.slice(0, n)
  }

  return list
})

async function refresh() {
  collections.value = await window.bond.listCollections()
  if (targetCollection.value) {
    items.value = await window.bond.listCollectionItems(targetCollection.value.id)
  }
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

function getPrimaryField(schema: FieldDef[]): FieldDef | undefined {
  return schema.find(f => f.primary)
}

function getItemLabel(item: CollectionItem, schema: FieldDef[]): string {
  const primary = getPrimaryField(schema)
  if (primary) {
    const val = item.data[primary.name]
    if (val != null) return String(val)
  }
  return item.id.slice(0, 8)
}

function formatValue(value: unknown, field: FieldDef): string {
  if (value == null) return '—'
  switch (field.type) {
    case 'boolean': return value ? 'Yes' : 'No'
    case 'number': return `${field.prefix ?? ''}${value}${field.suffix ?? ''}`
    default: return Array.isArray(value) ? value.join(', ') : String(value)
  }
}
</script>

<template>
  <div class="collection-embed">
    <div v-if="loading" class="embed-loading">Loading collections...</div>

    <!-- Overview: all collections as cards -->
    <template v-else-if="showOverview">
      <div v-if="collections.length === 0" class="embed-empty">No collections</div>
      <div v-else class="collection-cards">
        <div v-for="col in collections.filter(c => !c.archived)" :key="col.id" class="collection-card">
          <span v-if="col.icon" class="collection-icon">{{ col.icon }}</span>
          <span class="collection-name">{{ col.name }}</span>
          <span class="collection-count">{{ col.schema.length }} fields</span>
        </div>
      </div>
    </template>

    <!-- Single collection: items table -->
    <template v-else-if="targetCollection">
      <div v-if="filteredItems.length === 0" class="embed-empty">
        No items in {{ targetCollection.icon }} {{ targetCollection.name }}
      </div>
      <div v-else class="collection-items">
        <div v-for="item in filteredItems" :key="item.id" class="item-row">
          <span class="item-label">{{ getItemLabel(item, targetCollection.schema) }}</span>
          <div class="item-fields">
            <template v-for="field in targetCollection.schema.filter(f => !f.primary)" :key="field.name">
              <span v-if="item.data[field.name] != null" class="item-field">
                <template v-if="field.type === 'rating'">
                  <span class="rating">
                    <template v-for="n in (field.max ?? 5)" :key="n">
                      <PhStar v-if="n <= (item.data[field.name] as number)" :size="12" weight="fill" class="star star--filled" />
                      <PhStar v-else :size="12" class="star star--empty" />
                    </template>
                  </span>
                </template>
                <template v-else-if="field.type === 'select'">
                  <span class="field-badge">{{ item.data[field.name] }}</span>
                </template>
                <template v-else-if="field.type === 'url'">
                  <a class="field-link" @click.prevent="window.bond.openExternal(String(item.data[field.name]))">{{ field.name }}</a>
                </template>
                <template v-else>
                  <span class="field-value">{{ formatValue(item.data[field.name], field) }}</span>
                </template>
              </span>
            </template>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="embed-empty">Collection not found: {{ name }}</div>
  </div>
</template>

<style scoped>
.collection-embed {
  padding: 0.5em 0;
}

.embed-loading, .embed-empty {
  font-size: 0.8em;
  color: var(--color-muted);
  padding: 0.25em 0;
}

.collection-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5em;
}

.collection-card {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.4em 0.75em;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: 0.875em;
}

.collection-icon {
  font-size: 1.1em;
}

.collection-name {
  font-weight: 500;
}

.collection-count {
  color: var(--color-muted);
  font-size: 0.8em;
}

.collection-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-row {
  display: flex;
  align-items: baseline;
  gap: 0.75em;
  padding: 0.3em 0;
  font-size: 0.875em;
}

.item-label {
  font-weight: 500;
  flex-shrink: 0;
}

.item-fields {
  display: flex;
  align-items: center;
  gap: 0.5em;
  flex-wrap: wrap;
  min-width: 0;
}

.item-field {
  display: inline-flex;
  align-items: center;
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
  font-size: 0.75em;
  color: var(--color-muted);
  background: var(--color-tint);
  padding: 0.1em 0.5em;
  border-radius: var(--radius-sm);
}

.field-value {
  color: var(--color-muted);
  font-size: 0.85em;
}

.field-link {
  color: var(--color-accent);
  font-size: 0.85em;
  cursor: pointer;
  text-decoration: underline;
}
</style>
