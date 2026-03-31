<script setup lang="ts">
import { inject, ref, onMounted, onUnmounted, computed } from 'vue'
import { PhCaretRight } from '@phosphor-icons/vue'
import { PANEL_GROUP_KEY, type PanelUnit } from './panelTypes'

const props = withDefaults(defineProps<{
  id: string
  defaultSize?: number
  minSize?: number
  maxSize?: number
  minSizePx?: number
  unit?: PanelUnit
  collapsible?: boolean
  collapsedSize?: number
  header?: string
}>(), {
  defaultSize: 50,
  minSize: 10,
  maxSize: 100,
  unit: '%',
  collapsible: false,
  collapsedSize: 0,
})

const group = inject(PANEL_GROUP_KEY)!
if (!group) {
  throw new Error('BondPanel must be used inside BondPanelGroup')
}

const size = computed(() => group.getPanelSize(props.id))
const flexStyle = computed(() => group.getFlexStyle(props.id))
const minDimStyle = computed(() => {
  const val = group.getMinDimStyle(props.id)
  return group.direction.value === 'horizontal'
    ? { minWidth: val }
    : { minHeight: val }
})

// When header is present, collapse is handled locally (content hidden, panel
// shrinks to header height). When header is absent, collapse is handled by the
// group (panel shrinks to collapsedSize).
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
      minSizePx: props.minSizePx,
      unit: props.unit,
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
    :style="header && (localCollapsed || collapsible) ? { flex: '0 0 auto' } : { flex: flexStyle, ...minDimStyle }"
  >
    <div v-if="header" class="bond-panel__header" :class="{ 'bond-panel__header--clickable': collapsible }" @click="collapsible && toggleCollapse()">
      <span class="bond-panel__header-label">
        {{ header }}
        <PhCaretRight v-if="collapsible" class="bond-panel__chevron" :class="{ collapsed: isCollapsed }" :size="12" weight="bold" />
      </span>
      <div class="bond-panel__header-actions">
        <slot name="header-extra" />
      </div>
    </div>
    <div v-if="header" class="bond-panel__content" :class="{ 'bond-panel__content--collapsed': localCollapsed }">
      <div class="bond-panel__content-inner">
        <slot :size="size" :collapsed="isCollapsed" />
      </div>
    </div>
    <div v-else class="bond-panel__body">
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
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0.75rem 0.625rem 1rem;
  user-select: none;
}

.bond-panel__header--clickable {
  cursor: pointer;
}
.bond-panel__header--clickable:hover .bond-panel__header-label {
  color: var(--color-text-primary);
}

.bond-panel__header-label {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-muted);
  transition: color var(--transition-base);
}

.bond-panel__header-actions {
  display: flex;
  align-items: center;
  gap: 0.125rem;
}

.bond-panel__chevron {
  transition: transform var(--transition-base);
  transform: rotate(90deg);
}

.bond-panel__chevron.collapsed {
  transform: rotate(0deg);
}

.bond-panel__content {
  flex: 1;
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--transition-base);
  min-height: 0;
}

.bond-panel__content--collapsed {
  grid-template-rows: 0fr;
}

.bond-panel__content-inner {
  overflow: hidden;
  min-height: 0;
}

/* Non-header panels: simple flex child, no grid transition.
   Group-managed collapse handles animation via animateSizes(). */
.bond-panel__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
