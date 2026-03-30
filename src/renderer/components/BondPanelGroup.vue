<script setup lang="ts">
import { ref, provide, computed, watch } from 'vue'
import { PANEL_GROUP_KEY, type PanelDirection, type PanelRegistration, type PanelGroupContext } from './panelTypes'

const props = withDefaults(defineProps<{
  direction?: PanelDirection
  autoSaveId?: string
  keyboardStep?: number
}>(), {
  direction: 'horizontal',
  keyboardStep: 5,
})

const emit = defineEmits<{
  layoutChange: [layout: Record<string, number>]
  layoutChanged: [layout: Record<string, number>]
}>()

// Ordered panel registrations
const panels = ref<PanelRegistration[]>([])
// Current sizes as percentages keyed by panel id
const sizes = ref<Record<string, number>>({})
// Track collapsed state separately
const collapsed = ref<Set<string>>(new Set())
// Sizes saved before collapse, for restore
const preCollapseSize = ref<Record<string, number>>({})

// Active resize state
let resizeHandleId: string | null = null
let resizeStartSizes: Record<string, number> = {}

const groupEl = ref<HTMLElement | null>(null)

// --- Persistence ---
function storageKey() {
  return props.autoSaveId ? `bond:panels:${props.autoSaveId}` : null
}

function saveLayout() {
  const key = storageKey()
  if (key) {
    localStorage.setItem(key, JSON.stringify({
      sizes: sizes.value,
      collapsed: [...collapsed.value],
      preCollapseSize: preCollapseSize.value,
    }))
  }
}

function loadLayout(): { sizes: Record<string, number>; collapsed: string[]; preCollapseSize?: Record<string, number> } | null {
  const key = storageKey()
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// --- Layout computation ---
function distributeDefaults() {
  const regs = panels.value
  if (regs.length === 0) return

  const saved = loadLayout()
  if (saved && regs.every((r) => saved.sizes[r.id] !== undefined)) {
    // Clamp saved sizes against current constraints so stale layouts
    // respect updated minSize / maxSize values.
    const collapsedSet = new Set(saved.collapsed.filter((id) => regs.some((r) => r.id === id)))
    const clamped: Record<string, number> = {}
    for (const r of regs) {
      const s = saved.sizes[r.id]
      if (collapsedSet.has(r.id)) {
        clamped[r.id] = s
      } else {
        clamped[r.id] = Math.min(r.constraints.maxSize, Math.max(r.constraints.minSize, s))
      }
    }
    // Normalize so sizes still sum to 100
    const total = Object.values(clamped).reduce((a, b) => a + b, 0)
    if (total > 0 && Math.abs(total - 100) > 0.1) {
      const scale = 100 / total
      for (const id of Object.keys(clamped)) {
        clamped[id] *= scale
      }
    }
    sizes.value = clamped
    collapsed.value = collapsedSet
    if (saved.preCollapseSize) {
      preCollapseSize.value = { ...saved.preCollapseSize }
    }
    return
  }

  // Use defaultSizes, normalize to sum to 100
  const total = regs.reduce((s, r) => s + r.constraints.defaultSize, 0)
  const newSizes: Record<string, number> = {}
  for (const r of regs) {
    newSizes[r.id] = (r.constraints.defaultSize / total) * 100
  }
  sizes.value = newSizes
}

function getEffectiveMinSize(reg: PanelRegistration): number {
  const { minSize, minSizePx } = reg.constraints
  if (!minSizePx || !groupEl.value) return minSize
  const groupPx = props.direction === 'horizontal'
    ? groupEl.value.offsetWidth
    : groupEl.value.offsetHeight
  if (groupPx <= 0) return minSize
  const pxAsPercent = (minSizePx / groupPx) * 100
  return Math.max(minSize, pxAsPercent)
}

function clampSize(id: string, size: number): number {
  const reg = panels.value.find((p) => p.id === id)
  if (!reg) return size
  const { maxSize, collapsible, collapsedSize } = reg.constraints
  if (collapsible && collapsed.value.has(id)) {
    return collapsedSize
  }
  return Math.min(maxSize, Math.max(getEffectiveMinSize(reg), size))
}

// --- Panel registration ---
function registerPanel(reg: PanelRegistration) {
  // Insert in DOM order — we rely on component mount order which follows template order
  const existing = panels.value.findIndex((p) => p.id === reg.id)
  if (existing !== -1) {
    panels.value[existing] = reg
  } else {
    panels.value = [...panels.value, reg]
  }
  distributeDefaults()
}

function unregisterPanel(id: string) {
  panels.value = panels.value.filter((p) => p.id !== id)
  const { [id]: _, ...rest } = sizes.value
  sizes.value = rest
  collapsed.value.delete(id)
}

function getPanelSize(id: string): number {
  return sizes.value[id] ?? 0
}

function getPanelIds(): string[] {
  return panels.value.map((p) => p.id)
}

// --- Handle helpers ---
function getHandlePanels(handleId: string): { before: string; after: string } | null {
  // Handle ID format: "handle-{index}" where index is the handle's position (0-based)
  const match = handleId.match(/^handle-(\d+)$/)
  if (!match) return null
  const idx = parseInt(match[1], 10)
  const ids = getPanelIds()
  if (idx < 0 || idx >= ids.length - 1) return null
  return { before: ids[idx], after: ids[idx + 1] }
}

// --- Resize logic ---
function startResize(handleId: string) {
  resizeHandleId = handleId
  resizeStartSizes = { ...sizes.value }
}

function moveResize(delta: number) {
  if (!resizeHandleId) return
  applyResizeDelta(resizeHandleId, delta)
  emit('layoutChange', { ...sizes.value })
}

function endResize() {
  if (!resizeHandleId) return
  resizeHandleId = null
  resizeStartSizes = {}
  emit('layoutChanged', { ...sizes.value })
  saveLayout()
}

function keyboardResize(handleId: string, delta: number) {
  applyResizeDelta(handleId, delta)
  emit('layoutChange', { ...sizes.value })
  emit('layoutChanged', { ...sizes.value })
  saveLayout()
}

function applyResizeDelta(handleId: string, deltaPercent: number) {
  const pair = getHandlePanels(handleId)
  if (!pair) return

  const { before, after } = pair
  const beforeReg = panels.value.find((p) => p.id === before)
  const afterReg = panels.value.find((p) => p.id === after)
  if (!beforeReg || !afterReg) return

  const beforeMin = getEffectiveMinSize(beforeReg)
  const afterMin = getEffectiveMinSize(afterReg)

  const currentBefore = sizes.value[before] ?? 0
  const currentAfter = sizes.value[after] ?? 0
  const combined = currentBefore + currentAfter

  // Calculate proposed sizes
  let newBefore = currentBefore + deltaPercent
  let newAfter = currentAfter - deltaPercent

  // Handle collapse thresholds
  if (beforeReg.constraints.collapsible && newBefore < beforeMin) {
    if (newBefore <= beforeReg.constraints.collapsedSize + (beforeMin - beforeReg.constraints.collapsedSize) / 2) {
      collapsed.value.add(before)
      newBefore = beforeReg.constraints.collapsedSize
      newAfter = combined - newBefore
    } else {
      newBefore = beforeMin
      newAfter = combined - newBefore
    }
  } else if (collapsed.value.has(before) && deltaPercent > 0) {
    // Expanding from collapsed
    collapsed.value.delete(before)
    newBefore = beforeMin
    newAfter = combined - newBefore
  }

  if (afterReg.constraints.collapsible && newAfter < afterMin) {
    if (newAfter <= afterReg.constraints.collapsedSize + (afterMin - afterReg.constraints.collapsedSize) / 2) {
      collapsed.value.add(after)
      newAfter = afterReg.constraints.collapsedSize
      newBefore = combined - newAfter
    } else {
      newAfter = afterMin
      newBefore = combined - newAfter
    }
  } else if (collapsed.value.has(after) && deltaPercent < 0) {
    collapsed.value.delete(after)
    newAfter = afterMin
    newBefore = combined - newAfter
  }

  // Clamp both sides (unless collapsed, which is handled above)
  if (!collapsed.value.has(before)) {
    newBefore = Math.max(beforeMin, Math.min(beforeReg.constraints.maxSize, newBefore))
    newAfter = combined - newBefore
  }
  if (!collapsed.value.has(after)) {
    newAfter = Math.max(afterMin, Math.min(afterReg.constraints.maxSize, newAfter))
    newBefore = combined - newAfter
  }

  sizes.value = {
    ...sizes.value,
    [before]: newBefore,
    [after]: newAfter,
  }
}

// --- Animation helper ---
const ANIMATE_DURATION = 150
let animationFrame: number | null = null

function animateSizes(
  targetId: string,
  neighborId: string,
  targetEnd: number,
  neighborEnd: number,
  onComplete: () => void,
) {
  if (animationFrame) cancelAnimationFrame(animationFrame)

  const targetStart = sizes.value[targetId] ?? 0
  const neighborStart = sizes.value[neighborId] ?? 0
  const startTime = performance.now()

  function tick(now: number) {
    const elapsed = now - startTime
    const t = Math.min(elapsed / ANIMATE_DURATION, 1)
    // ease-out cubic
    const ease = 1 - Math.pow(1 - t, 3)

    sizes.value = {
      ...sizes.value,
      [targetId]: targetStart + (targetEnd - targetStart) * ease,
      [neighborId]: neighborStart + (neighborEnd - neighborStart) * ease,
    }

    if (t < 1) {
      animationFrame = requestAnimationFrame(tick)
    } else {
      animationFrame = null
      onComplete()
    }
  }

  animationFrame = requestAnimationFrame(tick)
}

// --- Collapse / expand ---
function collapsePanel(id: string) {
  const reg = panels.value.find((p) => p.id === id)
  if (!reg || !reg.constraints.collapsible || collapsed.value.has(id)) return

  preCollapseSize.value[id] = sizes.value[id] ?? reg.constraints.defaultSize

  const idx = panels.value.findIndex((p) => p.id === id)
  const neighborIdx = idx < panels.value.length - 1 ? idx + 1 : idx - 1
  if (neighborIdx < 0) return
  const neighbor = panels.value[neighborIdx]

  const currentSize = sizes.value[id] ?? 0
  const neighborSize = sizes.value[neighbor.id] ?? 0
  const targetEnd = reg.constraints.collapsedSize
  const neighborEnd = neighborSize + (currentSize - targetEnd)

  collapsed.value = new Set([...collapsed.value, id])

  animateSizes(id, neighbor.id, targetEnd, neighborEnd, () => {
    emit('layoutChanged', { ...sizes.value })
    saveLayout()
  })
}

function expandPanel(id: string) {
  const reg = panels.value.find((p) => p.id === id)
  if (!reg || !collapsed.value.has(id)) return

  const restoreTo = preCollapseSize.value[id] ?? reg.constraints.defaultSize
  const currentSize = sizes.value[id] ?? 0
  const needed = restoreTo - currentSize

  const idx = panels.value.findIndex((p) => p.id === id)
  const neighborIdx = idx < panels.value.length - 1 ? idx + 1 : idx - 1
  if (neighborIdx < 0) return
  const neighbor = panels.value[neighborIdx]

  const newCollapsed = new Set(collapsed.value)
  newCollapsed.delete(id)
  collapsed.value = newCollapsed

  const neighborSize = sizes.value[neighbor.id] ?? 0
  const neighborMin = getEffectiveMinSize(neighbor)
  const available = neighborSize - neighborMin
  const take = Math.min(needed, available)

  const targetEnd = currentSize + take
  const neighborEnd = neighborSize - take

  animateSizes(id, neighbor.id, targetEnd, neighborEnd, () => {
    delete preCollapseSize.value[id]
    emit('layoutChanged', { ...sizes.value })
    saveLayout()
  })
}

function isPanelCollapsed(id: string): boolean {
  return collapsed.value.has(id)
}

function resizePanel(id: string, size: number) {
  const reg = panels.value.find((p) => p.id === id)
  if (!reg) return

  const clamped = clampSize(id, size)
  const delta = clamped - (sizes.value[id] ?? 0)
  if (Math.abs(delta) < 0.01) return

  // Take/give space to neighbor
  const idx = panels.value.findIndex((p) => p.id === id)
  const neighborIdx = idx < panels.value.length - 1 ? idx + 1 : idx - 1
  if (neighborIdx < 0) return
  const neighbor = panels.value[neighborIdx]

  sizes.value = {
    ...sizes.value,
    [id]: clamped,
    [neighbor.id]: (sizes.value[neighbor.id] ?? 0) - delta,
  }
  emit('layoutChanged', { ...sizes.value })
  saveLayout()
}

// Watch for direction changes to re-emit
watch(() => props.direction, () => {
  emit('layoutChange', { ...sizes.value })
})

provide(PANEL_GROUP_KEY, {
  direction: computed(() => props.direction),
  registerPanel,
  unregisterPanel,
  getPanelSize,
  getPanelIds,
  startResize,
  moveResize,
  endResize,
  keyboardResize,
  collapsePanel,
  expandPanel,
  isPanelCollapsed,
  resizePanel,
  getHandlePanels,
})

defineExpose({
  getLayout: () => ({ ...sizes.value }),
  setLayout: (layout: Record<string, number>) => {
    sizes.value = { ...layout }
    saveLayout()
  },
})
</script>

<template>
  <div
    ref="groupEl"
    class="bond-panel-group"
    :class="`bond-panel-group--${direction}`"
    :data-direction="direction"
  >
    <slot />
  </div>
</template>

<style scoped>
.bond-panel-group {
  display: flex;
  overflow: hidden;
  /* Width and height come from the consumer or from being nested inside a BondPanel */
}

.bond-panel-group--horizontal {
  flex-direction: row;
}

.bond-panel-group--vertical {
  flex-direction: column;
}
</style>
