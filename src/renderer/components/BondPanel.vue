<script setup lang="ts">
import { inject, ref, onMounted, onUnmounted, computed } from 'vue'
import { PANEL_GROUP_KEY } from './panelTypes'

const props = withDefaults(defineProps<{
  id: string
  defaultSize?: number
  minSize?: number
  maxSize?: number
  collapsible?: boolean
  collapsedSize?: number
  header?: string
}>(), {
  defaultSize: 50,
  minSize: 10,
  maxSize: 100,
  collapsible: false,
  collapsedSize: 0,
})

const group = inject(PANEL_GROUP_KEY)
if (!group) {
  throw new Error('BondPanel must be used inside BondPanelGroup')
}

const size = computed(() => group.getPanelSize(props.id))

// When header is present, collapse is handled locally (content hidden, panel
// shrinks to header height). When header is absent, collapse is handled by the
// group (panel shrinks to collapsedSize %).
const localCollapsed = ref(false)
const isCollapsed = computed(() =>
  props.header ? localCollapsed.value : group.isPanelCollapsed(props.id)
)

function toggleCollapse() {
  if (props.header) {
    localCollapsed.value = !localCollapsed.value
  } else if (isCollapsed.value) {
    group.expandPanel(props.id)
  } else {
    group.collapsePanel(props.id)
  }
}

onMounted(() => {
  group.registerPanel({
    id: props.id,
    constraints: {
      defaultSize: props.defaultSize,
      minSize: props.minSize,
      maxSize: props.maxSize,
      collapsible: props.header ? false : props.collapsible,
      collapsedSize: props.collapsedSize,
    },
  })
})

onUnmounted(() => {
  group.unregisterPanel(props.id)
})

defineExpose({
  collapse: () => {
    if (props.header) { localCollapsed.value = true } else { group.collapsePanel(props.id) }
  },
  expand: () => {
    if (props.header) { localCollapsed.value = false } else { group.expandPanel(props.id) }
  },
  getSize: () => group.getPanelSize(props.id),
  isCollapsed: () => isCollapsed.value,
  resize: (size: number) => group.resizePanel(props.id, size),
})
</script>

<template>
  <div
    class="bond-panel"
    :data-panel-id="id"
    :data-state="isCollapsed ? 'collapsed' : 'expanded'"
    :style="localCollapsed && header ? { flex: '0 0 auto' } : { flex: `1 0 ${size}%` }"
  >
    <button
      v-if="header && collapsible"
      type="button"
      class="bond-panel__header"
      @click="toggleCollapse"
    >
      <span class="bond-panel__header-label">{{ header }}</span>
      <slot name="header-extra" />
      <span class="bond-panel__chevron" :class="{ collapsed: isCollapsed }">&#9654;</span>
    </button>
    <div v-if="header && !collapsible" class="bond-panel__header bond-panel__header--static">
      <span class="bond-panel__header-label">{{ header }}</span>
      <slot name="header-extra" />
    </div>
    <div v-show="!isCollapsed" class="bond-panel__content">
      <slot :size="size" :collapsed="isCollapsed" />
    </div>
  </div>
</template>

<style scoped>
.bond-panel {
  overflow: hidden;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.bond-panel__header {
  all: unset;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-muted);
  transition: color var(--transition-base);
  user-select: none;
}

.bond-panel__header:hover {
  color: var(--color-text-primary);
}

.bond-panel__header--static {
  cursor: default;
}
.bond-panel__header--static:hover {
  color: var(--color-muted);
}

.bond-panel__header-label {
  flex: 1;
}

.bond-panel__chevron {
  font-size: 0.55rem;
  transition: transform var(--transition-base);
  transform: rotate(90deg);
}

.bond-panel__chevron.collapsed {
  transform: rotate(0deg);
}

.bond-panel__content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
