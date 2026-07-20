<script setup lang="ts">
import { computed } from 'vue'
import { PhStar, PhCheck } from '@phosphor-icons/vue'
import type { FieldDef } from '../../../shared/session'
import { formatFieldValue, optionLabel, optionsOf } from '../../../shared/fields'
import { fieldColorVar, optionColorVar } from '../../lib/fieldColors'

/**
 * The single per-type display dispatch for collection field values — used by
 * the table, list, cards, item detail, and chat embed so they can never drift.
 * Purely presentational; interactivity (bool toggles, editing) stays with the
 * caller.
 */
const props = defineProps<{
  value: unknown
  def: FieldDef
}>()

const kind = computed(() => {
  if (props.value == null || props.value === '') return 'empty'
  switch (props.def.type) {
    case 'rating': return typeof props.value === 'number' ? 'rating' : 'text'
    case 'boolean': return 'boolean'
    case 'url': return 'url'
    case 'select': return 'badge'
    case 'status':
    case 'priority': return 'chip'
    case 'tags':
    case 'multiselect': return Array.isArray(props.value) ? 'tags' : 'text'
    default: return 'text'
  }
})

const text = computed(() => formatFieldValue(props.value, props.def))
const chipColor = computed(() => optionColorVar(props.def, props.value))
const ratingMax = computed(() => props.def.max ?? 5)
const ratingValue = computed(() => (typeof props.value === 'number' ? props.value : 0))

const tagItems = computed(() => {
  if (!Array.isArray(props.value)) return []
  const opts = optionsOf(props.def)
  return props.value.map(v => {
    const opt = opts.find(o => o.value === v)
    return {
      key: String(v),
      label: opt ? optionLabel(opt) : String(v),
      color: fieldColorVar(opt?.color),
    }
  })
})

function openUrl(event: Event) {
  // Rows that host this value navigate on click — a link must win
  event.stopPropagation()
  void window.bond.openExternal(String(props.value))
}
</script>

<template>
  <span v-if="kind === 'empty'" class="fv-empty">—</span>

  <span v-else-if="kind === 'rating'" class="fv-rating" :aria-label="`${ratingValue} of ${ratingMax}`">
    <template v-for="n in ratingMax" :key="n">
      <PhStar v-if="n <= ratingValue" :size="13" weight="fill" class="fv-star fv-star--filled" />
      <PhStar v-else :size="13" class="fv-star fv-star--empty" />
    </template>
  </span>

  <span v-else-if="kind === 'boolean'" class="fv-bool" :class="{ 'fv-bool--on': value === true }">
    <PhCheck v-if="value === true" :size="13" weight="bold" />
    <template v-else>—</template>
  </span>

  <a v-else-if="kind === 'url'" class="fv-link" @click.prevent="openUrl">{{ text }}</a>

  <span v-else-if="kind === 'badge'" class="fv-badge">{{ text }}</span>

  <span v-else-if="kind === 'chip'" class="fv-chip">
    <span v-if="chipColor" class="fv-chip-dot" :style="{ background: chipColor }" />
    {{ text }}
  </span>

  <span v-else-if="kind === 'tags'" class="fv-tags">
    <span v-for="tag in tagItems" :key="tag.key" class="fv-tag">
      <span v-if="tag.color" class="fv-chip-dot" :style="{ background: tag.color }" />
      {{ tag.label }}
    </span>
  </span>

  <span v-else class="fv-text">{{ text }}</span>
</template>

<style scoped>
.fv-empty {
  color: var(--color-muted);
}

.fv-rating {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.fv-star--filled { color: var(--color-accent); }
.fv-star--empty { color: var(--color-border); }

.fv-bool {
  color: var(--color-muted);
}

.fv-bool--on {
  color: var(--color-ok);
}

.fv-link {
  color: var(--color-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.fv-badge,
.fv-chip,
.fv-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.5rem;
  background: var(--color-tint);
  border-radius: var(--radius-full);
  font-size: 0.85em;
  white-space: nowrap;
}

.fv-chip-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.fv-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
</style>
