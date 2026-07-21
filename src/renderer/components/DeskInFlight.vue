<script setup lang="ts">
/**
 * **In flight** — work threads Bond *observed* you doing.
 *
 * Each row: colour mark, thread name, **the re-entry note**, and coarse time.
 * The note is the point of the whole feature; the time is secondary decoration,
 * which is why it is small, muted, and always carries a tilde.
 *
 * Absent by design: percentages, app-usage bars, focus scores, comparisons to
 * yesterday. Desk describes, it never grades.
 */
import { computed } from 'vue'
import { appColor } from '../composables/useSense'
import { formatApproxDuration } from '../../shared/desk'
import type { DeskBlockDetail, DeskThread } from '../../shared/desk'

const props = defineProps<{
  blocks: DeskBlockDetail[]
  threads: DeskThread[]
  isDark?: boolean
  /** The block whose thread picker is open, if any. */
  reassigning?: string | null
  busy?: boolean
}>()

const emit = defineEmits<{
  reassign: [blockId: string, threadId: string]
  openPicker: [blockId: string | null]
}>()

const rows = computed(() => props.blocks.filter(block => block.thread))

function colorFor(block: DeskBlockDetail): string {
  return appColor(block.thread!.id, props.isDark ?? false)
}

/** Threads you could move a block to — everything except where it already is. */
function optionsFor(block: DeskBlockDetail): DeskThread[] {
  return props.threads.filter(t => t.id !== block.threadId)
}
</script>

<template>
  <div class="desk-list">
    <p v-if="rows.length === 0" class="desk-empty">
      Nothing observed yet.
    </p>

    <div v-for="block in rows" :key="block.id" class="desk-row">
      <button
        type="button"
        class="desk-row-main"
        :disabled="busy"
        @click="emit('openPicker', reassigning === block.id ? null : block.id)"
      >
        <span class="desk-row-mark" :style="{ background: colorFor(block) }" />
        <span class="desk-row-body">
          <span class="desk-row-head">
            <span class="desk-row-name">{{ block.thread!.name }}</span>
            <!-- Always approximate. The tilde is the panel telling you not to audit it. -->
            <span class="desk-row-time">{{ formatApproxDuration(block.presenceSeconds) }}</span>
          </span>
          <span v-if="block.reentryNote" class="desk-row-note">{{ block.reentryNote }}</span>
          <span v-else-if="block.noteStatus === 'pending'" class="desk-row-note is-faint">writing a note…</span>
        </span>
      </button>

      <!-- Reassignment is optimistic and instant; the rule write happens behind it. -->
      <div v-if="reassigning === block.id" class="desk-picker">
        <p class="desk-picker-label">Move to</p>
        <button
          v-for="thread in optionsFor(block)"
          :key="thread.id"
          type="button"
          class="desk-picker-option"
          @click="emit('reassign', block.id, thread.id)"
        >
          <span class="desk-row-mark" :style="{ background: appColor(thread.id, isDark ?? false) }" />
          {{ thread.name }}
        </button>
        <p v-if="optionsFor(block).length === 0" class="desk-empty">No other threads yet.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.desk-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.desk-empty {
  font: 400 11px/1.4 var(--font-sans, system-ui);
  opacity: 0.5;
  padding: 0.25rem 0.5rem;
  margin: 0;
}

.desk-row-main {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.5rem;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.desk-row-main:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.07);
}

.desk-row-mark {
  flex-shrink: 0;
  width: 3px;
  align-self: stretch;
  min-height: 14px;
  border-radius: 999px;
  margin-top: 2px;
}

.desk-row-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.desk-row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.desk-row-name {
  font: 500 12px/1.3 var(--font-sans, system-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Time is secondary decoration; the note is the product. */
.desk-row-time {
  flex-shrink: 0;
  font: 400 10px/1.3 var(--font-sans, system-ui);
  opacity: 0.45;
  font-variant-numeric: tabular-nums;
}

.desk-row-note {
  font: 400 11px/1.35 var(--font-sans, system-ui);
  opacity: 0.72;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.desk-row-note.is-faint {
  opacity: 0.4;
  font-style: italic;
}

.desk-picker {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.25rem 0.5rem 0.5rem 1.25rem;
}

.desk-picker-label {
  font: 500 10px/1.4 var(--font-sans, system-ui);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.4;
  margin: 0 0 0.125rem;
}

.desk-picker-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  background: transparent;
  border: 0;
  border-radius: 5px;
  color: inherit;
  font: 400 11px/1.3 var(--font-sans, system-ui);
  text-align: left;
  cursor: pointer;
}

.desk-picker-option:hover {
  background: rgba(255, 255, 255, 0.1);
}

.desk-picker-option .desk-row-mark {
  min-height: 11px;
  align-self: center;
}
</style>
