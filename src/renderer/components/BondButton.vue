<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: boolean
  disabled?: boolean
}>()
</script>

<template>
  <button
    type="button"
    :disabled="disabled"
    :class="[
      'bond-btn',
      `bond-btn--${variant ?? 'secondary'}`,
      `bond-btn--${size ?? 'md'}`,
      { 'bond-btn--icon': icon },
    ]"
  >
    <slot />
  </button>
</template>

<style scoped>
.bond-btn {
  all: unset;
  -webkit-app-region: no-drag;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  font-family: inherit;
  font-weight: 600;
  border-radius: var(--radius-lg);
  transition: background var(--transition-base), color var(--transition-base), opacity var(--transition-base);
  box-sizing: border-box;
}

.bond-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Sizes */
.bond-btn--sm {
  font-size: 0.8125rem;
  padding: 0.3rem 0.75rem;
  border-radius: var(--radius-md);
}
.bond-btn--md {
  font-size: 0.875rem;
  padding: 0.425rem 1rem;
}

/* Icon-only — square with equal padding */
.bond-btn--icon.bond-btn--sm {
  width: 26px;
  height: 26px;
  padding: 0;
}
.bond-btn--icon.bond-btn--md {
  width: 30px;
  height: 30px;
  padding: 0;
}

/* Primary — filled accent */
.bond-btn--primary {
  background: var(--color-accent);
  color: #fff;
}
.bond-btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 85%, black);
}

/* Secondary — bordered */
.bond-btn--secondary {
  background: transparent;
  color: var(--color-text-primary);
  box-shadow: inset 0 0 0 1px var(--color-border);
}
.bond-btn--secondary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
}

/* Ghost — no border */
.bond-btn--ghost {
  background: transparent;
  color: var(--color-muted);
}
.bond-btn--ghost:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
  color: var(--color-text-primary);
}

/* Danger — destructive */
.bond-btn--danger {
  background: transparent;
  color: var(--color-err);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-err) 40%, transparent);
}
.bond-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-err) 12%, transparent);
}
</style>
