<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhCaretDown, PhCheck } from '@phosphor-icons/vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'

const props = defineProps<{
  modelValue?: string
  disabled?: boolean
  options: { value: string; label: string }[]
  placement?: 'top' | 'bottom'
  variant?: 'default' | 'minimal'
  size?: 'sm' | 'md'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const focusedIndex = ref(-1)

const selectedLabel = computed(() => {
  const opt = props.options.find(o => o.value === props.modelValue)
  return opt?.label ?? props.modelValue ?? ''
})

const flyoutPlacement = computed(() =>
  props.placement === 'top' ? 'top-start' as const : 'bottom-start' as const
)

function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    focusedIndex.value = props.options.findIndex(o => o.value === props.modelValue)
  }
}

function select(value: string) {
  emit('update:modelValue', value)
  open.value = false
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!open.value) { toggle(); return }
    focusedIndex.value = Math.min(focusedIndex.value + 1, props.options.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!open.value) { toggle(); return }
    focusedIndex.value = Math.max(focusedIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (open.value && focusedIndex.value >= 0) {
      select(props.options[focusedIndex.value].value)
    } else {
      toggle()
    }
  }
}
</script>

<template>
  <div class="bond-select-wrap">
    <button
      ref="triggerEl"
      type="button"
      class="bond-select-trigger"
      :class="{ 'is-minimal': variant === 'minimal', 'is-sm': size === 'sm' }"
      :disabled="disabled"
      @click="toggle"
      @keydown="handleKeyDown"
    >
      <span class="bond-select-label">{{ selectedLabel }}</span>
      <PhCaretDown
        class="bond-select-icon"
        :style="{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }"
        :size="12"
        weight="bold"
      />
    </button>

    <BondFlyoutMenu
      :open="open"
      :anchor="triggerEl"
      :placement="flyoutPlacement"
      padding
      @close="open = false"
    >
      <button
        v-for="(opt, i) in options"
        :key="opt.value"
        type="button"
        class="bond-select-option"
        :class="{ selected: opt.value === modelValue, focused: i === focusedIndex }"
        @click="select(opt.value)"
        @mouseenter="focusedIndex = i"
      >
        <span class="bond-select-check-slot">
          <PhCheck v-if="opt.value === modelValue" :size="12" weight="bold" />
        </span>
        <span>{{ opt.label }}</span>
      </button>
    </BondFlyoutMenu>
  </div>
</template>

<style scoped>
.bond-select-wrap {
  display: inline-block;
}

.bond-select-trigger {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem 0.375rem 0.65rem;
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-base);
  white-space: nowrap;
}

.bond-select-trigger.is-sm {
  padding: 0.25rem 0.375rem 0.25rem 0.5rem;
  font-size: 0.75rem;
}

.bond-select-trigger.is-minimal {
  background: transparent;
  border-color: transparent;
}

.bond-select-trigger.is-minimal:hover {
  border-color: transparent;
  color: var(--color-accent);
}

.bond-select-trigger.is-minimal:hover .bond-select-icon {
  color: var(--color-accent);
}

.bond-select-trigger:hover {
  border-color: var(--color-muted);
}

.bond-select-trigger:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.bond-select-trigger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bond-select-label {
  flex: 1;
  text-align: left;
}

.bond-select-icon {
  color: var(--color-muted);
  flex-shrink: 0;
  transition: transform var(--transition-fast);
}

.bond-select-option {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem;
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  white-space: nowrap;
  text-align: left;
  transition: background var(--transition-fast);
}

.bond-select-option.focused {
  background: var(--color-tint);
}

.bond-select-option.selected {
  font-weight: 500;
}

.bond-select-check-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
  color: var(--color-accent);
}

</style>
