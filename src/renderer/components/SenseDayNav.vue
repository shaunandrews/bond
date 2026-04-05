<script setup lang="ts">
import { computed } from 'vue'
import { PhCaretLeft, PhCaretRight } from '@phosphor-icons/vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'

const props = defineProps<{
  date: string
  isToday: boolean
  captureCount: number
  sessionCount: number
}>()

const emit = defineEmits<{
  prev: []
  next: []
  pick: [date: string]
}>()

const formattedDate = computed(() => {
  const d = new Date(props.date + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
})

const subtitle = computed(() => {
  if (props.captureCount === 0) return 'No captures'
  const parts = [`${props.captureCount} captures`]
  if (props.sessionCount > 0) {
    parts.push(`${props.sessionCount} ${props.sessionCount === 1 ? 'session' : 'sessions'}`)
  }
  return parts.join(', ')
})

function handleDatePick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.value) emit('pick', input.value)
}
</script>

<template>
  <div class="sense-day-nav">
    <BondButton variant="ghost" size="sm" icon @click="emit('prev')" v-tooltip="'Previous day'">
      <PhCaretLeft :size="14" weight="bold" />
    </BondButton>

    <label class="date-label">
      <BondText size="sm" weight="medium">{{ formattedDate }}</BondText>
      <BondText v-if="captureCount > 0" size="xs" color="muted" class="ml-1.5">{{ subtitle }}</BondText>
      <input type="date" class="date-picker-hidden" :value="date" @change="handleDatePick" />
    </label>

    <BondButton variant="ghost" size="sm" icon :disabled="isToday" @click="emit('next')" v-tooltip="'Next day'">
      <PhCaretRight :size="14" weight="bold" />
    </BondButton>
  </div>
</template>

<style scoped>
.sense-day-nav {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.date-label {
  display: flex;
  align-items: baseline;
  gap: 0;
  cursor: pointer;
  position: relative;
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.date-label:hover {
  background: var(--color-tint);
}

.date-picker-hidden {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
}
</style>
