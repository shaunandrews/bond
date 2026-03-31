<script setup lang="ts">
defineProps<{
  label: string
  border?: 'none' | 'bottom'
  drag?: boolean
  blur?: boolean
}>()
</script>

<template>
  <div
    role="toolbar"
    :aria-label="label"
    :class="['bond-toolbar', {
      'bond-toolbar--border': border === 'bottom',
      'bond-toolbar--blur': blur,
      'drag-region': drag,
    }]"
  >
    <div v-if="$slots.start" class="bond-toolbar__start no-drag">
      <slot name="start" />
    </div>
    <div v-if="$slots.middle" class="bond-toolbar__middle">
      <slot name="middle" />
    </div>
    <div v-if="$slots.end" class="bond-toolbar__end no-drag">
      <slot name="end" />
    </div>
  </div>
</template>

<style scoped>
.bond-toolbar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  height: var(--toolbar-height);
  padding-inline: 0.75rem;
  flex-shrink: 0;
}

.bond-toolbar--border {
  border-bottom: 1px solid var(--color-border);
}

.bond-toolbar--blur::before {
  content: '';
  position: absolute;
  top: 0;
  left: 4px;
  right: 0;
  bottom: -24px;
  z-index: -1;
  backdrop-filter: blur(12px);
  mask-image: linear-gradient(to bottom, black 40%, transparent);
}

.bond-toolbar__start {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  justify-self: start;
}

.bond-toolbar__middle {
  grid-column: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  user-select: none;
}

.bond-toolbar__end {
  grid-column: 3;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  justify-self: end;
}
</style>
