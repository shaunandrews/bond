<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'

const props = defineProps<{
  embedType: string
  attrs: Record<string, string>
}>()

const components: Record<string, ReturnType<typeof defineAsyncComponent>> = {
  todos: defineAsyncComponent(() => import('./embeds/TodoEmbed.vue')),
  project: defineAsyncComponent(() => import('./embeds/ProjectEmbed.vue')),
  media: defineAsyncComponent(() => import('./embeds/MediaEmbed.vue')),
  collection: defineAsyncComponent(() => import('./embeds/CollectionEmbed.vue')),
}

const component = computed(() => components[props.embedType] ?? null)
</script>

<template>
  <component
    v-if="component"
    :is="component"
    v-bind="attrs"
  />
  <div v-else class="text-xs text-muted italic py-1">
    Unknown embed: {{ embedType }}
  </div>
</template>
