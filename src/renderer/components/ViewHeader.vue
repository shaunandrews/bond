<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <div class="px-6 pt-4 pb-2 text-center">
    <h1 class="text-sm font-medium text-muted m-0 select-none">{{ title }}</h1>
    <p v-if="subtitle" class="text-xs text-muted mt-0.5 m-0">{{ subtitle }}</p>
  </div>
</template>
