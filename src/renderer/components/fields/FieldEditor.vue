<script setup lang="ts">
import { computed, ref } from 'vue'
import { PhStar, PhX } from '@phosphor-icons/vue'
import type { FieldDef } from '../../../shared/session'
import { optionLabel, optionsOf } from '../../../shared/fields'
import { fieldColorVar } from '../../lib/fieldColors'
import BondInput from '../BondInput.vue'
import BondTextarea from '../BondTextarea.vue'
import BondSelect from '../BondSelect.vue'

/**
 * The single per-type input dispatch for collection fields. v-model carries
 * CANONICAL values (number for number/rating, string[] for tags/multiselect,
 * boolean for boolean) — undefined means "not set". Callers hand the model
 * straight to collection.addItem/updateItem with no string re-parsing.
 */
const props = defineProps<{
  def: FieldDef
  modelValue: unknown
}>()

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
}>()

const kind = computed(() => {
  switch (props.def.type) {
    case 'longtext': return 'longtext'
    case 'number': return 'number'
    case 'date': return 'date'
    case 'boolean': return 'boolean'
    case 'rating': return 'rating'
    case 'select':
    case 'status':
    case 'priority': return 'option'
    case 'multiselect': return 'multiselect'
    case 'tags': return 'tags'
    default: return 'text'
  }
})

// --- text-ish ---
const textValue = computed(() => (props.modelValue == null ? '' : String(props.modelValue)))

function setText(value: string) {
  emit('update:modelValue', value.trim() === '' ? undefined : value)
}

function setNumber(value: string) {
  const trimmed = value.trim()
  if (trimmed === '') return emit('update:modelValue', undefined)
  const n = Number(trimmed)
  emit('update:modelValue', Number.isFinite(n) ? n : undefined)
}

// --- optioned (select/status/priority) ---
const selectOptions = computed(() => [
  { value: '', label: '—' },
  ...optionsOf(props.def).map(o => ({
    value: o.value,
    label: optionLabel(o),
    color: fieldColorVar(o.color) ?? undefined,
  })),
])

function setOption(value: string) {
  emit('update:modelValue', value === '' ? undefined : value)
}

// --- boolean ---
function toggleBoolean() {
  emit('update:modelValue', props.modelValue !== true)
}

// --- rating ---
const ratingMax = computed(() => props.def.max ?? 5)
const ratingValue = computed(() => (typeof props.modelValue === 'number' ? props.modelValue : 0))

function setRating(n: number) {
  // Clicking the current value clears the rating
  emit('update:modelValue', n === ratingValue.value ? undefined : n)
}

function handleRatingKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault()
    emit('update:modelValue', Math.min(ratingMax.value, ratingValue.value + 1))
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault()
    const next = Math.max(0, ratingValue.value - 1)
    emit('update:modelValue', next === 0 ? undefined : next)
  }
}

// --- multiselect (toggle chips) + tags (free chips) ---
const arrayValue = computed(() => (Array.isArray(props.modelValue) ? props.modelValue.map(String) : []))

function toggleMember(value: string) {
  const current = arrayValue.value
  const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value]
  emit('update:modelValue', next.length ? next : undefined)
}

const tagDraft = ref('')

function commitTag() {
  const tag = tagDraft.value.trim().replace(/,+$/, '')
  tagDraft.value = ''
  if (!tag || arrayValue.value.includes(tag)) return
  emit('update:modelValue', [...arrayValue.value, tag])
}

function handleTagKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    commitTag()
  } else if (e.key === 'Backspace' && tagDraft.value === '' && arrayValue.value.length) {
    removeTag(arrayValue.value[arrayValue.value.length - 1])
  }
}

function removeTag(tag: string) {
  const next = arrayValue.value.filter(v => v !== tag)
  emit('update:modelValue', next.length ? next : undefined)
}
</script>

<template>
  <BondTextarea
    v-if="kind === 'longtext'"
    :model-value="textValue"
    :rows="4"
    :placeholder="def.name"
    @update:model-value="setText"
  />

  <BondInput
    v-else-if="kind === 'number'"
    type="number"
    :model-value="textValue"
    :placeholder="def.name"
    @update:model-value="setNumber"
  />

  <BondInput
    v-else-if="kind === 'date'"
    type="date"
    :model-value="textValue"
    @update:model-value="setText"
  />

  <button
    v-else-if="kind === 'boolean'"
    type="button"
    class="fe-toggle"
    role="switch"
    :aria-checked="modelValue === true"
    @click="toggleBoolean"
  >
    <span class="fe-toggle-track" :class="{ 'fe-toggle-track--on': modelValue === true }">
      <span class="fe-toggle-thumb" />
    </span>
    <span class="fe-toggle-label">{{ modelValue === true ? 'Yes' : 'No' }}</span>
  </button>

  <div
    v-else-if="kind === 'rating'"
    class="fe-rating"
    role="slider"
    tabindex="0"
    :aria-valuemin="0"
    :aria-valuemax="ratingMax"
    :aria-valuenow="ratingValue"
    :aria-label="def.name"
    @keydown="handleRatingKey"
  >
    <button
      v-for="n in ratingMax"
      :key="n"
      type="button"
      class="fe-star"
      tabindex="-1"
      :aria-label="`${n} of ${ratingMax}`"
      @click="setRating(n)"
    >
      <PhStar :size="16" :weight="n <= ratingValue ? 'fill' : 'regular'" :class="n <= ratingValue ? 'fe-star--filled' : 'fe-star--empty'" />
    </button>
  </div>

  <BondSelect
    v-else-if="kind === 'option'"
    :model-value="typeof modelValue === 'string' ? modelValue : ''"
    :options="selectOptions"
    @update:model-value="setOption"
  />

  <div v-else-if="kind === 'multiselect'" class="fe-chips" role="group" :aria-label="def.name">
    <button
      v-for="opt in optionsOf(def)"
      :key="opt.value"
      type="button"
      class="fe-chip"
      :class="{ 'fe-chip--on': arrayValue.includes(opt.value) }"
      :aria-pressed="arrayValue.includes(opt.value)"
      @click="toggleMember(opt.value)"
    >
      <span v-if="fieldColorVar(opt.color)" class="fe-chip-dot" :style="{ background: fieldColorVar(opt.color)! }" />
      {{ optionLabel(opt) }}
    </button>
  </div>

  <div v-else-if="kind === 'tags'" class="fe-tags">
    <span v-for="tag in arrayValue" :key="tag" class="fe-chip fe-chip--on">
      {{ tag }}
      <button type="button" class="fe-chip-remove" :aria-label="`Remove ${tag}`" @click="removeTag(tag)">
        <PhX :size="10" weight="bold" />
      </button>
    </span>
    <input
      v-model="tagDraft"
      class="fe-tag-input"
      type="text"
      :placeholder="arrayValue.length ? '' : 'Add tags…'"
      @keydown="handleTagKey"
      @blur="commitTag"
    />
  </div>

  <BondInput
    v-else
    :model-value="textValue"
    :placeholder="def.name"
    @update:model-value="setText"
  />
</template>

<style scoped>
.fe-toggle {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  cursor: pointer;
}

.fe-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.fe-toggle-track {
  display: inline-flex;
  align-items: center;
  width: 30px;
  height: 18px;
  padding: 2px;
  background: var(--color-border);
  border-radius: var(--radius-full);
  transition: background var(--transition-base);
}

.fe-toggle-track--on {
  background: var(--color-accent);
}

.fe-toggle-thumb {
  width: 14px;
  height: 14px;
  background: var(--color-surface);
  border-radius: var(--radius-full);
  transition: transform var(--transition-base);
}

.fe-toggle-track--on .fe-toggle-thumb {
  transform: translateX(12px);
}

.fe-toggle-label {
  color: var(--color-muted);
}

.fe-rating {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.fe-rating:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.fe-star {
  appearance: none;
  padding: 1px;
  background: none;
  border: none;
  cursor: pointer;
  display: inline-flex;
}

.fe-star--filled { color: var(--color-accent); }
.fe-star--empty { color: var(--color-muted); }

.fe-chips,
.fe-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.fe-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.55rem;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  font-family: inherit;
  font-size: 0.75rem;
  color: var(--color-muted);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast);
}

.fe-chip:hover {
  border-color: var(--color-muted);
}

.fe-chip--on {
  color: var(--color-text-primary);
  background: var(--color-tint);
  border-color: transparent;
}

.fe-chip-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.fe-chip-remove {
  appearance: none;
  display: inline-flex;
  padding: 0;
  margin-left: 0.1rem;
  background: none;
  border: none;
  color: var(--color-muted);
  cursor: pointer;
}

.fe-chip-remove:hover {
  color: var(--color-text-primary);
}

.fe-tag-input {
  flex: 1;
  min-width: 90px;
  padding: 0.2rem 0.1rem;
  background: transparent;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.fe-tag-input::placeholder {
  color: var(--color-muted);
}
</style>
