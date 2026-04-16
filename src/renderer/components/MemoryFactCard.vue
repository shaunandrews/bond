<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { SenseFact } from '../../shared/sense'
import BondText from './BondText.vue'
import { PhX, PhPencilSimple, PhCheck } from '@phosphor-icons/vue'

const props = defineProps<{
  fact: SenseFact
}>()

const emit = defineEmits<{
  forget: [id: string]
  update: [id: string, text: string]
}>()

const editing = ref(false)
const editText = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)

function startEdit() {
  editText.value = props.fact.fact
  editing.value = true
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

function saveEdit() {
  const trimmed = editText.value.trim()
  if (trimmed && trimmed !== props.fact.fact) {
    emit('update', props.fact.id, trimmed)
  }
  editing.value = false
}

function cancelEdit() {
  editing.value = false
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    saveEdit()
  } else if (e.key === 'Escape') {
    cancelEdit()
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="fact-card" :class="{ editing }">
    <template v-if="editing">
      <textarea
        ref="inputRef"
        v-model="editText"
        class="fact-edit-input"
        rows="2"
        @keydown="handleKeydown"
        @blur="saveEdit"
      />
      <div class="fact-footer">
        <BondText size="xs" color="muted">Enter to save, Esc to cancel</BondText>
        <button class="fact-action fact-save" @mousedown.prevent="saveEdit">
          <PhCheck :size="12" />
        </button>
      </div>
    </template>
    <template v-else>
      <BondText size="sm" class="fact-text">{{ fact.fact }}</BondText>
      <div class="fact-footer">
        <BondText size="xs" color="muted">Pinned {{ formatDate(fact.createdAt) }}</BondText>
        <div class="fact-actions">
          <button class="fact-action fact-edit" @click.stop="startEdit" v-tooltip="'Edit'">
            <PhPencilSimple :size="12" />
          </button>
          <button class="fact-action fact-remove" @click.stop="emit('forget', fact.id)" v-tooltip="'Forget'">
            <PhX :size="12" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fact-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.5rem 0.625rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.fact-card.editing {
  border-color: var(--color-accent);
}

.fact-text {
  line-height: 1.4;
}

.fact-edit-input {
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.4;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-primary);
  resize: none;
  outline: none;
  width: 100%;
}

.fact-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.fact-actions {
  display: none;
  align-items: center;
  gap: 0.125rem;
}

.fact-card:hover .fact-actions {
  display: flex;
}

.fact-action {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: none;
  color: var(--color-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast);
}

.fact-edit:hover {
  color: var(--color-text-primary);
}

.fact-remove:hover {
  color: var(--color-err);
}

.fact-save:hover {
  color: var(--color-accent);
}
</style>
