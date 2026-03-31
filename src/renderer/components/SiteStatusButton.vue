<script setup lang="ts">
defineProps<{
  running: boolean
  toggling?: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <button
    type="button"
    :class="['site-status-btn', { running, toggling }]"
    :disabled="toggling"
    v-tooltip="toggling ? (running ? 'Stopping...' : 'Starting...') : running ? 'Stop site' : 'Start site'"
    @click.stop="$emit('toggle')"
  >
    <span class="status-shape" />
  </button>
</template>

<style scoped>
.site-status-btn {
  all: unset;
  cursor: pointer;
  flex-shrink: 0;
  width: 24px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
}
.site-status-btn:disabled {
  cursor: default;
}

.status-shape {
  width: 10px;
  height: 10px;
  display: block;
  transition: clip-path 0.2s ease, background-color 0.2s ease;
}

/* --- Stopped: grey dot → green play triangle on hover --- */
.site-status-btn:not(.running):not(.toggling) .status-shape {
  background-color: var(--sidebar-text-faint);
  clip-path: polygon(50% 2%, 91% 25%, 91% 75%, 50% 98%, 9% 75%, 9% 25%);
}
.site-status-btn:not(.running):not(.toggling):hover .status-shape {
  background-color: var(--color-ok);
  clip-path: polygon(20% 8%, 88% 50%, 88% 50%, 20% 92%, 20% 65%, 20% 35%);
}

/* --- Running: green dot → red stop square on hover --- */
.site-status-btn.running:not(.toggling) .status-shape {
  background-color: var(--color-ok);
  clip-path: polygon(50% 2%, 91% 25%, 91% 75%, 50% 98%, 9% 75%, 9% 25%);
}
.site-status-btn.running:not(.toggling):hover .status-shape {
  background-color: var(--color-err);
  clip-path: polygon(15% 15%, 85% 15%, 85% 50%, 85% 85%, 15% 85%, 15% 50%);
}

/* --- Toggling: pulsing accent dot --- */
.site-status-btn.toggling .status-shape {
  background-color: var(--color-accent);
  clip-path: polygon(50% 2%, 91% 25%, 91% 75%, 50% 98%, 9% 75%, 9% 25%);
  animation: status-pulse 1s ease-in-out infinite;
}

@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
