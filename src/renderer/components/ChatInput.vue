<script setup lang="ts">
import { ref, watch, toRefs, nextTick } from 'vue'
import { PhCaretDown } from '@phosphor-icons/vue'
import { MODEL_IDS, type ModelId } from '../../shared/models'

const props = defineProps<{ busy: boolean; model: ModelId }>()
const { busy } = toRefs(props)

const emit = defineEmits<{
  submit: [text: string]
  cancel: []
  'update:model': [value: ModelId]
}>()

const models = MODEL_IDS.map(id => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))

const inputEl = ref<HTMLTextAreaElement | null>(null)

watch(busy, (isBusy) => {
  if (!isBusy) {
    nextTick(() => inputEl.value?.focus())
  }
})

function handleSubmit() {
  const text = inputEl.value?.value.trim()
  if (!text) return
  inputEl.value!.value = ''
  emit('submit', text)
  inputEl.value!.focus()
}

function focus() {
  inputEl.value?.focus()
}

defineExpose({ focus })

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmit()
  }
}
</script>

<template>
  <div>
    <div class="px-5 pt-3 pb-5">
      <textarea
        ref="inputEl"
        rows="3"
        placeholder="Ask Bond something…"
        :spellcheck="false"
        :disabled="busy"
        @keydown="handleKeyDown"
        class="w-full resize-y min-h-[4.5rem] max-h-48 px-3 py-2.5 rounded-lg border border-border bg-surface text-text-primary font-[inherit] text-base focus:outline-2 focus:outline-accent focus:outline-offset-1"
      />
      <div class="flex items-center justify-between mt-2">
        <div class="model-select-wrap">
          <select
            :value="model"
            class="model-select"
            @change="emit('update:model', ($event.target as HTMLSelectElement).value as ModelId)"
          >
            <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
          <PhCaretDown class="model-select-icon" :size="12" weight="bold" />
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="!busy"
            @click="emit('cancel')"
            class="text-sm font-semibold px-4 py-1.5 rounded-lg border border-border bg-transparent text-text-primary cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
          >
            Stop
          </button>
          <button
            type="button"
            :disabled="busy"
            @click="handleSubmit()"
            class="text-sm font-semibold px-4 py-1.5 rounded-lg border-transparent bg-accent text-white cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-select-wrap {
  position: relative;
  display: inline-block;
}

.model-select {
  appearance: none;
  background: var(--color-surface);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.3em 2em 0.3em 0.6em;
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
}
.model-select:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.model-select-icon {
  position: absolute;
  right: 0.5em;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-muted);
  pointer-events: none;
}
</style>
