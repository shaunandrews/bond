<script setup lang="ts">
/**
 * **Today** — todos *you* said you'd get to. Checkboxes.
 *
 * Kept structurally separate from In flight and never merged into one list.
 * One is inferred and one is intentional, and blurring that makes the inferred
 * half feel like an accusation.
 */
import { computed } from 'vue'
import type { CollectionItem } from '../../shared/session'

type TodayItem = CollectionItem & { threadId: string | null }

const props = defineProps<{
  items: TodayItem[]
  busy?: boolean
}>()

const emit = defineEmits<{
  toggle: [itemId: string, done: boolean]
  add: [title: string]
}>()

function titleOf(item: TodayItem): string {
  const value = (item.data as Record<string, unknown>).title
  return typeof value === 'string' && value ? value : 'Untitled'
}

function isDone(item: TodayItem): boolean {
  const status = (item.data as Record<string, unknown>).status
  return status === 'done' || status === 'cancelled'
}

/** Open work first; finished items sink but stay visible as progress. */
const ordered = computed(() =>
  [...props.items].sort((a, b) => Number(isDone(a)) - Number(isDone(b)))
)

function submit(event: Event): void {
  const input = event.target as HTMLInputElement
  const title = input.value.trim()
  if (!title) return
  emit('add', title)
  input.value = ''
}
</script>

<template>
  <div class="desk-today">
    <p v-if="ordered.length === 0" class="desk-empty">Nothing on today's list.</p>

    <label
      v-for="item in ordered"
      :key="item.id"
      class="desk-todo"
      :class="{ 'is-done': isDone(item) }"
    >
      <input
        type="checkbox"
        :checked="isDone(item)"
        :disabled="busy"
        @change="emit('toggle', item.id, ($event.target as HTMLInputElement).checked)"
      />
      <span class="desk-todo-title">{{ titleOf(item) }}</span>
      <!-- The one place the two lists meet: a todo linked to observed work. -->
      <span v-if="item.threadId" class="desk-todo-link" title="Linked to a thread">&#9679;</span>
    </label>

    <input
      class="desk-todo-add"
      type="text"
      placeholder="Add something for today…"
      :disabled="busy"
      @keydown.enter.prevent="submit"
    />
  </div>
</template>

<style scoped>
.desk-today {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.desk-empty {
  font: 400 11px/1.4 var(--font-sans, system-ui);
  opacity: 0.5;
  padding: 0.25rem 0.5rem;
  margin: 0;
}

.desk-todo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}

.desk-todo:hover {
  background: rgba(255, 255, 255, 0.07);
}

.desk-todo input {
  flex-shrink: 0;
  accent-color: currentColor;
  cursor: pointer;
}

.desk-todo-title {
  font: 400 12px/1.3 var(--font-sans, system-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.desk-todo.is-done .desk-todo-title {
  opacity: 0.4;
  text-decoration: line-through;
}

.desk-todo-link {
  flex-shrink: 0;
  font-size: 7px;
  opacity: 0.5;
}

.desk-todo-add {
  margin-top: 0.25rem;
  padding: 0.35rem 0.5rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: inherit;
  font: 400 11px/1.3 var(--font-sans, system-ui);
}

.desk-todo-add::placeholder {
  color: currentColor;
  opacity: 0.35;
}

.desk-todo-add:focus {
  outline: none;
  border-color: rgba(255, 255, 255, 0.25);
}
</style>
