<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { PhMinus, PhPlus, PhCornersOut, PhArrowClockwise } from '@phosphor-icons/vue'
import type { WpSiteMap, WpSiteMapNode } from '../../shared/wordpress'
import BondButton from './BondButton.vue'

const props = defineProps<{
  siteMap: WpSiteMap
  siteUrl: string
  refreshing?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

// --- Layout constants ---
const NODE_W = 180
const THUMB_H = 120
const LABEL_GAP = 36
const NODE_H = THUMB_H + LABEL_GAP
const GAP_X = 40
const GAP_Y = 60
const CORNER_R = 8
const MIN_ZOOM = 0.08
const MAX_ZOOM = 2
const ZOOM_STEP = 0.15
const PAN_THRESHOLD = 4

// --- Internal types ---
interface CNode {
  id: number | string
  label: string
  url: string
  isHome: boolean
  isCollection: boolean
  count: number
  children: CNode[]
}

interface PNode {
  id: number | string
  label: string
  url: string
  isHome: boolean
  isCollection: boolean
  count: number
  x: number
  y: number
  sw: number // subtree width
  children: PNode[]
}

interface Connector {
  id: string
  d: string
}

// --- Build unified tree from WpSiteMap ---
function buildTree(): CNode {
  const { pages, posts, homePageId } = props.siteMap
  const url = props.siteUrl

  function convert(n: WpSiteMapNode): CNode {
    return {
      id: n.id, label: n.title || '(Untitled)',
      url: n.url || `${url}/${n.slug}`,
      isHome: false, isCollection: false, count: 0,
      children: n.children.map(convert)
    }
  }

  let home: WpSiteMapNode | null = null
  const rest: WpSiteMapNode[] = []
  for (const p of pages) {
    if (homePageId != null && p.id === homePageId) home = p
    else rest.push(p)
  }

  const root: CNode = {
    id: home?.id ?? 'home',
    label: home?.title || 'Home',
    url, isHome: true, isCollection: false, count: 0,
    children: home ? home.children.map(convert) : []
  }
  for (const p of rest) root.children.push(convert(p))

  // Add posts collection — nest under blog page if one exists
  if (posts.length > 0) {
    const postsNode: CNode = {
      id: 'posts', label: 'Posts', url: '',
      isHome: false, isCollection: true, count: posts.length, children: []
    }
    const blog = root.children.find(c => {
      const l = c.label.toLowerCase()
      return l === 'blog' || l === 'news' || l === 'posts'
    })
    if (blog) blog.children.push(postsNode)
    else root.children.push(postsNode)
  }

  return root
}

// --- Layout algorithm ---
function subtreeW(n: CNode): number {
  if (!n.children.length) return NODE_W
  let w = 0
  for (let i = 0; i < n.children.length; i++) {
    if (i > 0) w += GAP_X
    w += subtreeW(n.children[i])
  }
  return Math.max(NODE_W, w)
}

function layout(n: CNode, left: number, top: number): PNode {
  const sw = subtreeW(n)
  const pn: PNode = {
    id: n.id, label: n.label, url: n.url,
    isHome: n.isHome, isCollection: n.isCollection, count: n.count,
    x: left + sw / 2 - NODE_W / 2, y: top, sw, children: []
  }
  let cx = left
  pn.children = n.children.map(child => {
    const cw = subtreeW(child)
    const p = layout(child, cx, top + NODE_H + GAP_Y)
    cx += cw + GAP_X
    return p
  })
  return pn
}

function flatten(n: PNode): PNode[] {
  return [n, ...n.children.flatMap(flatten)]
}

function connectors(n: PNode): Connector[] {
  const out: Connector[] = []
  const sx = n.x + NODE_W / 2
  const sy = n.y + NODE_H // bottom of card
  for (const c of n.children) {
    const tx = c.x + NODE_W / 2
    const ty = c.y + LABEL_GAP // top of card
    out.push({ id: `${n.id}-${c.id}`, d: stepPath(sx, sy, tx, ty) })
    out.push(...connectors(c))
  }
  return out
}

function stepPath(sx: number, sy: number, tx: number, ty: number): string {
  if (Math.abs(tx - sx) < 1) return `M${sx} ${sy}L${tx} ${ty}`
  const my = (sy + ty) / 2
  const hv = Math.abs(my - sy)
  const hh = Math.abs(tx - sx)
  const r = Math.min(CORNER_R, hv, hh / 2)
  const dir = tx > sx ? 1 : -1
  return `M${sx} ${sy}L${sx} ${my - r}Q${sx} ${my} ${sx + r * dir} ${my}L${tx - r * dir} ${my}Q${tx} ${my} ${tx} ${my + r}L${tx} ${ty}`
}

// --- Computed layout ---
const tree = computed(() => buildTree())
const root = computed(() => layout(tree.value, 0, 0))
const nodes = computed(() => flatten(root.value))
const paths = computed(() => connectors(root.value))
const bounds = computed(() => {
  let mx = 0, my = 0
  for (const n of nodes.value) {
    mx = Math.max(mx, n.x + NODE_W)
    my = Math.max(my, n.y + NODE_H)
  }
  return { w: mx, h: my }
})

// --- Pan & Zoom ---
const viewportRef = ref<HTMLElement | null>(null)
const px = ref(0)
const py = ref(0)
const z = ref(0.5)
const dragging = ref(false)

let dsx = 0, dsy = 0, dpx = 0, dpy = 0, dmet = false

const surfaceStyle = computed(() => ({
  transform: `translate(${px.value}px, ${py.value}px) scale(${z.value})`,
  '--zoom': z.value
} as Record<string, string | number>))

const zoomPct = computed(() => Math.round(z.value * 100))

function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  dsx = e.clientX; dsy = e.clientY
  dpx = px.value; dpy = py.value; dmet = false
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onMove(e: PointerEvent) {
  if (!(e.currentTarget as HTMLElement)?.hasPointerCapture?.(e.pointerId)) return
  const dx = e.clientX - dsx, dy = e.clientY - dsy
  if (!dmet) {
    if (Math.abs(dx) + Math.abs(dy) < PAN_THRESHOLD) return
    dmet = true; dragging.value = true
  }
  px.value = dpx + dx; py.value = dpy + dy
}

function onUp(e: PointerEvent) {
  try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
  dragging.value = false
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    const d = -e.deltaY * 0.008
    zoomAt(z.value * (1 + d), e.clientX, e.clientY)
  } else {
    px.value -= e.deltaX
    py.value -= e.deltaY
  }
}

function zoomAt(nz: number, cx: number, cy: number) {
  nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nz))
  if (!viewportRef.value) { z.value = nz; return }
  const r = viewportRef.value.getBoundingClientRect()
  const lx = cx - r.left, ly = cy - r.top
  const s = nz / z.value
  px.value = lx - s * (lx - px.value)
  py.value = ly - s * (ly - py.value)
  z.value = nz
}

function zoomIn() { const c = vpCenter(); zoomAt(z.value + ZOOM_STEP, c.x, c.y) }
function zoomOut() { const c = vpCenter(); zoomAt(z.value - ZOOM_STEP, c.x, c.y) }

function fit() {
  if (!viewportRef.value) return
  const vw = viewportRef.value.clientWidth
  const vh = viewportRef.value.clientHeight
  const { w, h } = bounds.value
  if (!w || !h) return
  const pad = 80
  const fz = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h, 1)
  z.value = fz
  px.value = (vw - w * fz) / 2
  py.value = (vh - h * fz) / 2
}

function vpCenter() {
  if (!viewportRef.value) return { x: 0, y: 0 }
  const r = viewportRef.value.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

onMounted(() => nextTick(fit))
watch(() => props.siteMap, () => nextTick(fit))
</script>

<template>
  <div class="canvas-viewport" ref="viewportRef"
    @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp"
    @wheel="onWheel"
    :class="{ 'is-dragging': dragging }">

    <!-- Zoom controls -->
    <div class="canvas-controls">
      <BondButton variant="ghost" size="sm" icon @click="emit('refresh')" :disabled="refreshing" v-tooltip="'Refresh'">
        <PhArrowClockwise :size="14" :class="{ 'is-spinning': refreshing }" />
      </BondButton>
      <div class="controls-divider" />
      <BondButton variant="ghost" size="sm" icon @click="zoomOut" v-tooltip="'Zoom out'"><PhMinus :size="14" /></BondButton>
      <span class="zoom-label">{{ zoomPct }}%</span>
      <BondButton variant="ghost" size="sm" icon @click="zoomIn" v-tooltip="'Zoom in'"><PhPlus :size="14" /></BondButton>
      <BondButton variant="ghost" size="sm" icon @click="fit" v-tooltip="'Fit to screen'"><PhCornersOut :size="14" /></BondButton>
    </div>

    <!-- Canvas surface (transformed) -->
    <div class="canvas-surface" :style="surfaceStyle">
      <!-- SVG connectors -->
      <svg class="canvas-connectors" :width="bounds.w" :height="bounds.h" :viewBox="`0 0 ${bounds.w} ${bounds.h}`">
        <path v-for="c in paths" :key="c.id" :d="c.d" />
      </svg>

      <!-- Nodes -->
      <div v-for="node in nodes" :key="node.id"
        class="canvas-node"
        :class="{ 'is-home': node.isHome, 'is-collection': node.isCollection }"
        :style="{ transform: `translate(${node.x}px, ${node.y}px)` }">

        <!-- Label (above card, inverse-scaled) -->
        <span class="canvas-label">{{ node.label }}</span>

        <!-- Card -->
        <div class="canvas-card">
          <!-- Collection stack effect -->
          <template v-if="node.isCollection">
            <div class="stack-layer stack-2" />
            <div class="stack-layer stack-1" />
          </template>

          <div class="canvas-card-inner">
            <!-- Thumbnail iframe for pages -->
            <div v-if="!node.isCollection && node.url" class="canvas-thumb">
              <iframe :src="node.url" class="canvas-thumb-iframe"
                sandbox="allow-same-origin" loading="lazy" tabindex="-1" />
            </div>
            <!-- Placeholder for collection -->
            <div v-else class="canvas-placeholder" />
          </div>

          <!-- Collection badge -->
          <span v-if="node.isCollection && node.count" class="canvas-badge">{{ node.count }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.canvas-viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
  background-image: radial-gradient(circle, color-mix(in srgb, var(--color-border) 50%, transparent) 1px, transparent 1px);
  background-size: 24px 24px;
}
.canvas-viewport.is-dragging {
  cursor: grabbing;
}

.canvas-controls {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 0.125rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 0.125rem;
}

.controls-divider {
  width: 1px;
  height: 1rem;
  background: var(--color-border);
}

.is-spinning {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.zoom-label {
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--color-muted);
  min-width: 2.25rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.canvas-surface {
  position: absolute;
  transform-origin: 0 0;
}

/* SVG connectors */
.canvas-connectors {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  overflow: visible;
}
.canvas-connectors path {
  fill: none;
  stroke: var(--color-border);
  stroke-width: calc(2px / var(--zoom));
}

/* Node positioning */
.canvas-node {
  position: absolute;
  width: 180px;
}

/* Label above card */
.canvas-label {
  position: absolute;
  bottom: calc(100% - 36px + 4px);
  left: 0;
  transform: scale(calc(1 / var(--zoom)));
  transform-origin: bottom left;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  pointer-events: none;
}

/* Card container */
.canvas-card {
  position: relative;
  margin-top: 36px;
}

.canvas-card-inner {
  position: relative;
  width: 180px;
  height: 120px;
  background: var(--color-surface);
  border-radius: calc(var(--radius-lg) / var(--zoom, 1));
  overflow: hidden;
  box-shadow: 0 calc(1px / var(--zoom, 1)) calc(4px / var(--zoom, 1)) rgba(0,0,0,0.08);
  border: calc(1px / var(--zoom, 1)) solid var(--color-border);
}

/* Iframe thumbnail — render full page at 1000px then scale to 180px */
.canvas-thumb {
  width: 180px;
  height: 120px;
  overflow: hidden;
}
.canvas-thumb-iframe {
  width: 1000px;
  height: 667px;
  border: none;
  transform-origin: top left;
  transform: scale(0.18);
  pointer-events: none;
  display: block;
}

/* Placeholder for collections */
.canvas-placeholder {
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--color-border) 30%, var(--color-surface));
}

/* Stack effect for collections */
.stack-layer {
  position: absolute;
  width: 180px;
  height: 120px;
  background: var(--color-surface);
  border-radius: calc(var(--radius-lg) / var(--zoom, 1));
  border: calc(1px / var(--zoom, 1)) solid var(--color-border);
}
.stack-2 {
  top: calc(-6px / var(--zoom, 1));
  left: calc(6px / var(--zoom, 1));
  opacity: 0.4;
}
.stack-1 {
  top: calc(-3px / var(--zoom, 1));
  left: calc(3px / var(--zoom, 1));
  opacity: 0.7;
}

/* Collection count badge */
.canvas-badge {
  position: absolute;
  top: calc(36px - 6px);
  right: calc(-6px / var(--zoom, 1));
  transform: scale(calc(1 / var(--zoom)));
  transform-origin: top right;
  background: var(--color-accent);
  color: white;
  font-size: 0.6875rem;
  font-weight: 600;
  min-width: 1.25rem;
  height: 1.25rem;
  line-height: 1.25rem;
  text-align: center;
  border-radius: 999px;
  padding: 0 0.3rem;
}
</style>
