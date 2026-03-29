<template>
  <h1 class="text-sm font-medium text-muted m-0 text-center select-none truncate px-5 pt-4 pb-2">{{ title }}</h1>
</template>

<script setup lang="ts">
defineProps<{ title: string }>()
</script>
