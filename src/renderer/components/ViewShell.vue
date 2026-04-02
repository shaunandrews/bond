<script setup lang="ts">
import { ref, nextTick } from 'vue'
import BondToolbar from './BondToolbar.vue'

const props = defineProps<{
  title: string
  insetStart?: boolean
  titleEditable?: boolean
}>()

const emit = defineEmits<{
  rename: [title: string]
}>()

const scrollAreaEl = ref<HTMLElement | null>(null)
const editing = ref(false)
const editValue = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

function startEditing() {
  if (!props.titleEditable) return
  editing.value = true
  editValue.value = props.title
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

function commitEdit() {
  if (!editing.value) return
  editing.value = false
  const trimmed = editValue.value.trim()
  if (trimmed && trimmed !== props.title) {
    emit('rename', trimmed)
  }
}

function cancelEdit() {
  editing.value = false
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
}

defineExpose({ scrollAreaEl })
</script>

<template>
  <div class="view-shell">
    <div ref="scrollAreaEl" class="view-scroll-area">
      <BondToolbar
        label="View navigation"
        drag
        blur
        :insetStart="insetStart"
        class="view-header"
      >
        <template v-if="$slots['header-start']" #start>
          <slot name="header-start" />
          <input
            v-if="editing"
            ref="inputRef"
            v-model="editValue"
            class="view-title-input"
            :size="Math.max(editValue.length, 1)"
            @blur="commitEdit"
            @keydown="onInputKeydown"
            @input="inputRef && (inputRef.size = Math.max(editValue.length, 1))"
            @click.stop
            @dblclick.stop
          />
          <h1 v-else class="view-title" :class="{ editable: titleEditable }" v-tooltip="titleEditable ? 'Double-click to rename' : undefined" @dblclick="startEditing">{{ title }}</h1>
        </template>
        <template #middle>
          <!-- <h1 class="view-title">{{ title }}</h1> -->
        </template>
        <template v-if="$slots['header-end']" #end>
          <slot name="header-end" />
        </template>
      </BondToolbar>

      <div class="view-content">
        <slot />
      </div>

      <div v-if="$slots.footer" class="view-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.view-shell {
  position: relative;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.view-scroll-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.view-header {
  position: sticky;
  top: 0;
  z-index: 10;
}

.view-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-muted);
  margin: 0;
  text-align: center;
}

.view-title.editable {
  cursor: text;
  border-radius: var(--radius-sm);
  padding: 0 0.25rem;
}

.view-title.editable:hover {
  color: var(--color-text-primary);
}

.view-title-input {
  font-size: 0.875rem;
  font-weight: 500;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-accent, var(--color-border));
  border-radius: var(--radius-sm);
  padding: 0 0.25rem;
  outline: none;
  height: 1.5rem;
  width: auto;
}

.view-content {
  flex: 1;
}

.view-footer {
  position: sticky;
  bottom: 0;
  z-index: 10;
  pointer-events: none;
}

.view-footer > :deep(*) {
  pointer-events: auto;
}

.view-footer::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 4px;
  right: 0;
  bottom: 0;
  z-index: -1;
  backdrop-filter: blur(8px);
  mask-image: linear-gradient(to bottom, transparent, black 100px);
}
</style>
