<script setup lang="ts">
import { ref, provide, computed, watch, onMounted, onUnmounted } from 'vue'
import { PANEL_GROUP_KEY, type PanelDirection, type PanelRegistration, type PanelGroupContext, type PanelUnit } from './panelTypes'

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
// Current sizes keyed by panel id — in each panel's own unit (px or %)
const sizes = ref<Record<string, number>>({})
// Track collapsed state separately
const collapsed = ref<Set<string>>(new Set())
// Sizes saved before collapse, for restore (in panel's own unit)
const preCollapseSize = ref<Record<string, number>>({})

// Active resize state — the explicit panel pair being dragged, named by the
// handle itself (not derived from positional index, since a conditionally
// rendered middle panel shifts index-based adjacency).
let resizePair: { before: string; after: string } | null = null

const groupEl = ref<HTMLElement | null>(null)

// --- Unit helpers ---
function getPanelReg(id: string): PanelRegistration | undefined {
  return panels.value.find((p) => p.id === id)
}

function getPanelUnit(id: string): PanelUnit {
  return getPanelReg(id)?.constraints.unit ?? '%'
}

function getGroupPx(): number {
  if (!groupEl.value) return 1
  return props.direction === 'horizontal'
    ? groupEl.value.offsetWidth
    : groupEl.value.offsetHeight
}

/** Convert a percentage-of-group-width delta to pixels */
function percentToPx(pct: number): number {
  return (pct / 100) * getGroupPx()
}

/** Convert a pixel delta to percentage-of-group-width */
function pxToPercent(px: number): number {
  const g = getGroupPx()
  return g > 0 ? (px / g) * 100 : 0
}

// --- Flex style ---
function getFlexStyle(id: string): string {
  const size = sizes.value[id] ?? 0
  const unit = getPanelUnit(id)
  if (unit === 'px') {
    // flex-shrink: 1 lets px panels participate in flexbox shrinking when the
    // container is too small, working with CSS min-width to enforce minimums.
    return `0 1 ${size}px`
  }
  // Percentage panels use flex-grow to distribute remaining space
  return `${size} 0 0`
}

// --- Min dimension style ---
// Panels currently being animated need min-width suppressed so collapse/expand
// can smoothly transition through sizes below the panel's normal minimum.
const animatingPanels = ref<Set<string>>(new Set())

function getMinDimStyle(id: string): string {
  if (animatingPanels.value.has(id)) return '0px'
  if (collapsed.value.has(id)) return '0px'

  const reg = getPanelReg(id)
  if (!reg) return '0px'

  if (reg.constraints.unit === 'px') {
    return `${reg.constraints.minSize}px`
  }
  if (reg.constraints.minSizePx != null) {
    return `${reg.constraints.minSizePx}px`
  }
  return '0px'
}

// --- Persistence ---
function storageKey() {
  return props.autoSaveId ? `bond:panels:${props.autoSaveId}` : null
}

interface SavedLayout {
  sizes: Record<string, number>
  units?: Record<string, PanelUnit>
  collapsed: string[]
  preCollapseSize?: Record<string, number>
}

function saveLayout() {
  const key = storageKey()
  if (key) {
    const units: Record<string, PanelUnit> = {}
    for (const r of panels.value) {
      units[r.id] = r.constraints.unit
    }
    localStorage.setItem(key, JSON.stringify({
      sizes: sizes.value,
      units,
      collapsed: [...collapsed.value],
      preCollapseSize: preCollapseSize.value,
    }))
  }
}

function loadLayout(): SavedLayout | null {
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
/**
 * Matched PER PANEL, not all-or-nothing — a panel that's never been seen
 * before (the thread panel, first time it opens mid-session) falls back to
 * its own default without discarding every OTHER panel's saved size. The
 * previous "every registered panel needs a saved entry or default them all"
 * rule meant a single new panel id reset the whole group back to defaults.
 */
function distributeDefaults() {
  const regs = panels.value
  if (regs.length === 0) return

  const saved = loadLayout()
  const newSizes: Record<string, number> = {}
  const collapsedSet = new Set<string>()

  for (const r of regs) {
    const savedSize = saved?.sizes[r.id]
    const savedUnit = saved?.units?.[r.id] ?? '%'
    const hasSavedMatch = savedSize !== undefined && savedUnit === r.constraints.unit
    if (hasSavedMatch) {
      const wasCollapsed = saved!.collapsed.includes(r.id)
      newSizes[r.id] = wasCollapsed ? savedSize : Math.min(r.constraints.maxSize, Math.max(r.constraints.minSize, savedSize))
      if (wasCollapsed) collapsedSet.add(r.id)
    } else {
      newSizes[r.id] = r.constraints.defaultSize
    }
  }

  // Normalize % panels so their flex-grow weights sum correctly
  normalizePercentPanels(newSizes, regs)
  sizes.value = newSizes
  collapsed.value = collapsedSet
  if (saved?.preCollapseSize) {
    preCollapseSize.value = { ...saved.preCollapseSize }
  }
}

/** Normalize percentage panels so their flex-grow weights sum to 100 */
function normalizePercentPanels(sizeMap: Record<string, number>, regs: PanelRegistration[]) {
  const pctRegs = regs.filter((r) => r.constraints.unit === '%')
  if (pctRegs.length === 0) return

  const total = pctRegs.reduce((s, r) => s + (sizeMap[r.id] ?? 0), 0)
  if (total > 0 && Math.abs(total - 100) > 0.1) {
    const scale = 100 / total
    for (const r of pctRegs) {
      sizeMap[r.id] *= scale
    }
  }
}

function clampSize(id: string, size: number): number {
  const reg = getPanelReg(id)
  if (!reg) return size
  const { minSize, maxSize, collapsible, collapsedSize } = reg.constraints
  if (collapsible && collapsed.value.has(id)) {
    return collapsedSize
  }
  return Math.min(maxSize, Math.max(minSize, size))
}

// --- Panel registration ---
function registerPanel(reg: PanelRegistration) {
  const existing = panels.value.findIndex((p) => p.id === reg.id)
  if (existing !== -1) {
    // Updating constraints for an already-registered panel — replace registration
    // but do NOT redistribute defaults (that would reset sizes from localStorage).
    panels.value[existing] = reg
    return
  }

  panels.value = [...panels.value, reg]
  distributeDefaults()

  if (reg.initialCollapsed !== undefined && reg.constraints.collapsible) {
    const isCollapsed = collapsed.value.has(reg.id)
    if (reg.initialCollapsed && !isCollapsed) {
      preCollapseSize.value[reg.id] = sizes.value[reg.id] ?? reg.constraints.defaultSize
      collapsed.value = new Set([...collapsed.value, reg.id])
      sizes.value = { ...sizes.value, [reg.id]: reg.constraints.collapsedSize }
    } else if (!reg.initialCollapsed && isCollapsed) {
      const next = new Set(collapsed.value)
      next.delete(reg.id)
      collapsed.value = next
      const restore = preCollapseSize.value[reg.id] ?? reg.constraints.defaultSize
      sizes.value = { ...sizes.value, [reg.id]: restore }
    }
  }
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

// --- DOM sync ---
// When CSS flexbox shrinks px panels below their JS state (due to window resize),
// sync JS state to the actual rendered sizes so drags/animations start correctly.
function syncPxStateToDom(): boolean {
  if (!groupEl.value) return false
  const isH = props.direction === 'horizontal'
  const newSizes = { ...sizes.value }
  let changed = false

  for (const p of panels.value) {
    if (p.constraints.unit !== 'px' || collapsed.value.has(p.id)) continue
    const el = groupEl.value.querySelector(`[data-panel-id="${p.id}"]`) as HTMLElement | null
    if (!el) continue
    const rendered = isH ? el.offsetWidth : el.offsetHeight
    if (rendered <= 0) continue // no layout info (e.g. test environment)
    const jsState = newSizes[p.id] ?? 0
    if (Math.abs(rendered - jsState) > 1) {
      newSizes[p.id] = rendered
      changed = true
    }
  }

  if (changed) sizes.value = newSizes
  return changed
}

// The container can resize for reasons no drag/collapse triggers — an OS
// window resize, a sibling panel opening/closing elsewhere in the layout.
// Reconcile JS state (and what's persisted) to whatever CSS actually
// rendered, so a later drag starts from truth instead of a stale px number.
//
// Debounced until the resize settles: reconciling on every observer tick
// rewrites px flex-bases mid-resize, and each write lags the rendered width
// by a Vue tick — the flex shrink distribution jumps frame to frame and the
// panel seams visibly jitter during a manual OS window resize (plus a
// synchronous localStorage write per frame). CSS flexbox already renders the
// live resize correctly on its own; JS state only needs the end result.
let containerResizeObserver: ResizeObserver | null = null
let containerResizeSettleTimer: ReturnType<typeof setTimeout> | null = null
const CONTAINER_RESIZE_SETTLE_MS = 150

function handleContainerResize() {
  if (containerResizeSettleTimer) clearTimeout(containerResizeSettleTimer)
  containerResizeSettleTimer = setTimeout(() => {
    containerResizeSettleTimer = null
    // A drag in progress synced at startResize and saves at endResize —
    // reconciling under it would yank the handle out of the user's hand.
    if (resizePair) return
    if (syncPxStateToDom()) {
      emit('layoutChanged', { ...sizes.value })
      saveLayout()
    }
  }, CONTAINER_RESIZE_SETTLE_MS)
}

onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !groupEl.value) return
  containerResizeObserver = new ResizeObserver(handleContainerResize)
  containerResizeObserver.observe(groupEl.value)
})

onUnmounted(() => {
  containerResizeObserver?.disconnect()
  if (containerResizeSettleTimer) clearTimeout(containerResizeSettleTimer)
})

// --- Resize logic ---
function startResize(beforePanelId: string, afterPanelId: string) {
  syncPxStateToDom()
  resizePair = { before: beforePanelId, after: afterPanelId }
}

function moveResize(delta: number) {
  if (!resizePair) return
  applyResizeDelta(resizePair.before, resizePair.after, delta)
  emit('layoutChange', { ...sizes.value })
}

function endResize() {
  if (!resizePair) return
  resizePair = null
  emit('layoutChanged', { ...sizes.value })
  saveLayout()
}

function keyboardResize(beforePanelId: string, afterPanelId: string, delta: number) {
  applyResizeDelta(beforePanelId, afterPanelId, delta)
  emit('layoutChange', { ...sizes.value })
  emit('layoutChanged', { ...sizes.value })
  saveLayout()
}

function applyResizeDelta(before: string, after: string, deltaPercent: number) {
  const beforeReg = getPanelReg(before)
  const afterReg = getPanelReg(after)
  if (!beforeReg || !afterReg) return

  const beforeUnit = beforeReg.constraints.unit
  const afterUnit = afterReg.constraints.unit

  if (beforeUnit === 'px' && afterUnit !== 'px') {
    // Pixel panel before, flex panel after — only adjust pixel panel
    applyPxFlexDelta(before, beforeReg, deltaPercent)
  } else if (beforeUnit !== 'px' && afterUnit === 'px') {
    // Flex panel before, pixel panel after — adjust pixel panel (inverted delta)
    applyPxFlexDelta(after, afterReg, -deltaPercent)
  } else if (beforeUnit === 'px' && afterUnit === 'px') {
    // Both pixel — adjust both in pixels
    applyPxPxDelta(before, beforeReg, after, afterReg, deltaPercent)
  } else {
    // Both percentage — existing logic
    applyPctPctDelta(before, beforeReg, after, afterReg, deltaPercent)
  }
}

/** Resize a pixel panel against a flex neighbor. Only the pixel panel's size changes. */
function applyPxFlexDelta(pxId: string, pxReg: PanelRegistration, deltaPercent: number) {
  const deltaPx = percentToPx(deltaPercent)
  const current = sizes.value[pxId] ?? 0
  let newSize = current + deltaPx
  const { minSize, maxSize, collapsible, collapsedSize } = pxReg.constraints

  // Collapse threshold
  if (collapsible && newSize < minSize) {
    const threshold = collapsedSize + (minSize - collapsedSize) / 2
    if (newSize <= threshold) {
      collapsed.value.add(pxId)
      newSize = collapsedSize
    } else {
      newSize = minSize
    }
  } else if (collapsed.value.has(pxId) && deltaPx > 0) {
    collapsed.value.delete(pxId)
    newSize = minSize
  } else {
    newSize = Math.max(minSize, Math.min(maxSize, newSize))
  }

  // Ensure flex panels retain their pixel-based minimums
  if (!collapsed.value.has(pxId)) {
    const groupPx = getGroupPx()
    const otherPxTotal = panels.value.reduce((sum, p) => {
      if (p.constraints.unit === 'px' && p.id !== pxId) {
        return sum + (sizes.value[p.id] ?? 0)
      }
      return sum
    }, 0)
    const flexMinPx = panels.value
      .filter((p) => p.constraints.unit !== 'px')
      .reduce((sum, p) => sum + (p.constraints.minSizePx ?? 0), 0)
    const maxPxSize = groupPx - otherPxTotal - flexMinPx
    if (maxPxSize > 0) {
      newSize = Math.min(newSize, maxPxSize)
    }
  }

  sizes.value = { ...sizes.value, [pxId]: newSize }
}

/** Resize two pixel panels against each other. */
function applyPxPxDelta(beforeId: string, beforeReg: PanelRegistration, afterId: string, afterReg: PanelRegistration, deltaPercent: number) {
  const deltaPx = percentToPx(deltaPercent)
  const currentBefore = sizes.value[beforeId] ?? 0
  const currentAfter = sizes.value[afterId] ?? 0

  let newBefore = currentBefore + deltaPx
  let newAfter = currentAfter - deltaPx

  newBefore = Math.max(beforeReg.constraints.minSize, Math.min(beforeReg.constraints.maxSize, newBefore))
  newAfter = Math.max(afterReg.constraints.minSize, Math.min(afterReg.constraints.maxSize, newAfter))

  sizes.value = { ...sizes.value, [beforeId]: newBefore, [afterId]: newAfter }
}

/** Resize two percentage panels against each other (original logic). */
function applyPctPctDelta(beforeId: string, beforeReg: PanelRegistration, afterId: string, afterReg: PanelRegistration, deltaPercent: number) {
  const beforeMin = beforeReg.constraints.minSize
  const afterMin = afterReg.constraints.minSize

  const currentBefore = sizes.value[beforeId] ?? 0
  const currentAfter = sizes.value[afterId] ?? 0
  const combined = currentBefore + currentAfter

  let newBefore = currentBefore + deltaPercent
  let newAfter = currentAfter - deltaPercent

  // Handle collapse thresholds
  if (beforeReg.constraints.collapsible && newBefore < beforeMin) {
    if (newBefore <= beforeReg.constraints.collapsedSize + (beforeMin - beforeReg.constraints.collapsedSize) / 2) {
      collapsed.value.add(beforeId)
      newBefore = beforeReg.constraints.collapsedSize
      newAfter = combined - newBefore
    } else {
      newBefore = beforeMin
      newAfter = combined - newBefore
    }
  } else if (collapsed.value.has(beforeId) && deltaPercent > 0) {
    collapsed.value.delete(beforeId)
    newBefore = beforeMin
    newAfter = combined - newBefore
  }

  if (afterReg.constraints.collapsible && newAfter < afterMin) {
    if (newAfter <= afterReg.constraints.collapsedSize + (afterMin - afterReg.constraints.collapsedSize) / 2) {
      collapsed.value.add(afterId)
      newAfter = afterReg.constraints.collapsedSize
      newBefore = combined - newAfter
    } else {
      newAfter = afterMin
      newBefore = combined - newAfter
    }
  } else if (collapsed.value.has(afterId) && deltaPercent < 0) {
    collapsed.value.delete(afterId)
    newAfter = afterMin
    newBefore = combined - newAfter
  }

  // Clamp both sides (unless collapsed)
  if (!collapsed.value.has(beforeId)) {
    newBefore = Math.max(beforeMin, Math.min(beforeReg.constraints.maxSize, newBefore))
    newAfter = combined - newBefore
  }
  if (!collapsed.value.has(afterId)) {
    newAfter = Math.max(afterMin, Math.min(afterReg.constraints.maxSize, newAfter))
    newBefore = combined - newAfter
  }

  sizes.value = {
    ...sizes.value,
    [beforeId]: newBefore,
    [afterId]: newAfter,
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

  // Suppress min-width during animation so panels can transition smoothly
  animatingPanels.value = new Set([...animatingPanels.value, targetId, neighborId])

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
      const next = new Set(animatingPanels.value)
      next.delete(targetId)
      next.delete(neighborId)
      animatingPanels.value = next
      onComplete()
    }
  }

  animationFrame = requestAnimationFrame(tick)
}

// --- Collapse / expand ---
function collapsePanel(id: string) {
  const reg = getPanelReg(id)
  if (!reg || !reg.constraints.collapsible || collapsed.value.has(id)) return

  syncPxStateToDom()
  preCollapseSize.value[id] = sizes.value[id] ?? reg.constraints.defaultSize

  const idx = panels.value.findIndex((p) => p.id === id)
  const neighborIdx = idx < panels.value.length - 1 ? idx + 1 : idx - 1
  if (neighborIdx < 0) return
  const neighbor = panels.value[neighborIdx]

  const currentSize = sizes.value[id] ?? 0
  const neighborSize = sizes.value[neighbor.id] ?? 0
  const targetEnd = reg.constraints.collapsedSize

  collapsed.value = new Set([...collapsed.value, id])

  if (reg.constraints.unit === 'px' && neighbor.constraints.unit !== 'px') {
    // Pixel panel collapsing with flex neighbor — neighbor auto-fills, keep its value
    animateSizes(id, neighbor.id, targetEnd, neighborSize, () => {
      emit('layoutChanged', { ...sizes.value })
      saveLayout()
    })
  } else {
    // Same-unit panels — neighbor absorbs freed space
    const neighborEnd = neighborSize + (currentSize - targetEnd)
    animateSizes(id, neighbor.id, targetEnd, neighborEnd, () => {
      emit('layoutChanged', { ...sizes.value })
      saveLayout()
    })
  }
}

function expandPanel(id: string) {
  const reg = getPanelReg(id)
  if (!reg || !collapsed.value.has(id)) return

  syncPxStateToDom()
  const restoreTo = preCollapseSize.value[id] ?? reg.constraints.defaultSize
  const currentSize = sizes.value[id] ?? 0

  const idx = panels.value.findIndex((p) => p.id === id)
  const neighborIdx = idx < panels.value.length - 1 ? idx + 1 : idx - 1
  if (neighborIdx < 0) return
  const neighbor = panels.value[neighborIdx]
  const neighborSize = sizes.value[neighbor.id] ?? 0

  const newCollapsed = new Set(collapsed.value)
  newCollapsed.delete(id)
  collapsed.value = newCollapsed

  if (reg.constraints.unit === 'px' && neighbor.constraints.unit !== 'px') {
    // Pixel panel expanding — animate to restore size (CSS min-width handles flex constraints)
    const targetEnd = Math.max(reg.constraints.minSize, Math.min(restoreTo, reg.constraints.maxSize))

    animateSizes(id, neighbor.id, targetEnd, neighborSize, () => {
      delete preCollapseSize.value[id]
      emit('layoutChanged', { ...sizes.value })
      saveLayout()
    })
  } else {
    // Same-unit panels — take space from neighbor
    const needed = restoreTo - currentSize
    const neighborMin = neighbor.constraints.minSize
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
}

function isPanelCollapsed(id: string): boolean {
  return collapsed.value.has(id)
}

function resizePanel(id: string, size: number) {
  const reg = getPanelReg(id)
  if (!reg) return

  const clamped = clampSize(id, size)
  const delta = clamped - (sizes.value[id] ?? 0)
  if (Math.abs(delta) < 0.01) return

  const idx = panels.value.findIndex((p) => p.id === id)
  const neighborIdx = idx < panels.value.length - 1 ? idx + 1 : idx - 1
  if (neighborIdx < 0) return
  const neighbor = panels.value[neighborIdx]

  if (reg.constraints.unit === 'px' && neighbor.constraints.unit !== 'px') {
    // Pixel panel — just update its size, flex neighbor auto-fills
    sizes.value = { ...sizes.value, [id]: clamped }
  } else {
    sizes.value = {
      ...sizes.value,
      [id]: clamped,
      [neighbor.id]: (sizes.value[neighbor.id] ?? 0) - delta,
    }
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
  getPanelUnit,
  getFlexStyle,
  getMinDimStyle,
  getPanelIds,
  startResize,
  moveResize,
  endResize,
  keyboardResize,
  collapsePanel,
  expandPanel,
  isPanelCollapsed,
  resizePanel,
})

defineExpose({
  getLayout: () => ({ ...sizes.value }),
  setLayout: (layout: Record<string, number>) => {
    sizes.value = { ...layout }
    saveLayout()
  },
  // The width a panel occupies (or would, if currently collapsed) — its live
  // size when expanded, else the size it will restore to. Lets a consumer
  // grow/shrink the window by exactly a panel's width on open/close. Returns
  // 0 for an unregistered id (e.g. a conditionally-rendered panel not mounted).
  getExpandedWidth: (id: string): number => {
    const reg = getPanelReg(id)
    if (!reg) return 0
    if (collapsed.value.has(id)) return preCollapseSize.value[id] ?? reg.constraints.defaultSize
    return sizes.value[id] ?? reg.constraints.defaultSize
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
