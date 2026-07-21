<script setup lang="ts">
/**
 * Desk — the notch-anchored panel. Four states: Rest, Glance, Ask, Open.
 *
 * The window is created once at fully-expanded size, positioned once, and never
 * resized. `win.setBounds(bounds, true)` blocks the main process for ~340ms —
 * a synchronous, fixed-duration `NSWindow setFrame:display:` that cannot be
 * interrupted or retargeted — and resizing a transparent window per-frame is
 * the exact path that produces the known flicker artifacts.
 *
 * So every bit of motion is a CSS `transform`/`opacity` on a child inside a
 * fixed rect. Compositor-only. No width/height animation, no spring, no bounce.
 *
 * **Nothing here is ever an interrupt.** No modal, no sound, no bounce, no
 * Notification Center entry, no badge. Desk has exactly one channel.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { appColor } from './composables/useSense'
import DeskInFlight from './components/DeskInFlight.vue'
import DeskToday from './components/DeskToday.vue'
import { formatApproxDuration } from '../shared/desk'
import type { DeskBlockDetail, DeskStatus, DeskThread } from '../shared/desk'
import type { CollectionItem } from '../shared/session'
import type { DeskWindowGeometry, DeskHotRect } from '../shared/desk-window'

type TodayItem = CollectionItem & { threadId: string | null }

const geometry = ref<DeskWindowGeometry | null>(null)
const status = ref<DeskStatus | null>(null)
const inFlight = ref<DeskBlockDetail[]>([])
const threads = ref<DeskThread[]>([])
const todayItems = ref<TodayItem[]>([])
const hovering = ref(false)
const isDark = ref(false)
const busy = ref(false)
const reassigning = ref<string | null>(null)
/** What Bond learned from the last correction. Said once, visibly, then gone. */
const learned = ref<string | null>(null)

type Mode = 'rest' | 'glance' | 'ask' | 'open'
const mode = ref<Mode>('rest')

const pending = computed(() => status.value?.pendingQuestion ?? null)

/**
 * Thread identity is carried by colour. `appHue`/`appColor` already derive a
 * deterministic HSL from a bundle id — same function, keyed on thread id.
 */
const threadColor = computed(() => {
  const threadId = status.value?.currentBlock?.thread?.id
  if (!threadId) return null
  return appColor(threadId, isDark.value)
})

const currentName = computed(() => status.value?.currentBlock?.thread?.name ?? null)
const currentElapsed = computed(() => formatApproxDuration(status.value?.presenceSeconds ?? 0))

/**
 * Uncertainty is the third channel: dimmed while Bond is still deciding, which
 * is the whole of "Tick" in the assertion budget — change-blind, no motion.
 */
const uncertain = computed(() => {
  if (!status.value) return true
  if (!status.value.senseEnabled || status.value.senseState === 'disabled') return true
  if (status.value.backfilling) return true
  return !status.value.currentBlock?.thread
})

const askText = computed(() => {
  const q = pending.value
  if (!q) return ''
  if (q.kind === 'todo_started' && q.itemTitle) return `Looks like you're on "${q.itemTitle}" — mark it started?`
  return `Moved to ${q.proposedThreadName ?? 'something else'}?`
})

// --- geometry-driven layout ---

const restWidth = computed(() => geometry.value?.restWidth ?? 185)
const restHeight = computed(() => geometry.value?.restHeight ?? 41)
const menuBarHeight = computed(() => geometry.value?.menuBarHeight ?? 33)
const windowWidth = computed(() => geometry.value?.windowWidth ?? 640)

/**
 * The Rest hit target. Above the menu bar it is pinned to the notch's own
 * x-range — that rule is absolute. BELOW the bar there is no such constraint,
 * so the band is deliberately wider and taller than the 3pt hairline it
 * contains: an 8pt sliver directly under the camera housing is not a target
 * anyone can hit on purpose.
 */
const REST_HOVER_WIDTH = 240
const REST_HOVER_HEIGHT = 14

const GLANCE_WIDTH = 300
const GLANCE_HEIGHT = 36
const ASK_WIDTH = 380
const ASK_HEIGHT = 48
const OPEN_WIDTH = 400
const OPEN_MAX_HEIGHT = 420

const dropped = computed(() => mode.value !== 'rest')

const shapeStyle = computed(() => {
  if (mode.value === 'rest') {
    return {
      width: `${REST_HOVER_WIDTH}px`,
      height: `${menuBarHeight.value + REST_HOVER_HEIGHT}px`,
      top: '0px',
      borderRadius: '0',
    }
  }
  const width = mode.value === 'open' ? OPEN_WIDTH : mode.value === 'ask' ? ASK_WIDTH : GLANCE_WIDTH
  const height = mode.value === 'open' ? OPEN_MAX_HEIGHT : mode.value === 'ask' ? ASK_HEIGHT : GLANCE_HEIGHT
  return {
    width: `${width}px`,
    height: `${height}px`,
    // Everything that paints starts below the menu bar, never over it.
    top: `${menuBarHeight.value}px`,
    borderRadius: '0 0 14px 14px',
  }
})

/**
 * The hairline sits just BELOW the menu bar. Anything inside the notch's own
 * footprint is physically invisible — the framebuffer keeps those pixels (a
 * screenshot shows them fine) but the display cannot emit light through the
 * camera housing.
 */
const markStyle = computed(() => ({
  top: `${menuBarHeight.value + 2}px`,
  ...(threadColor.value ? { background: threadColor.value } : {}),
}))

// --- hit regions ---

/**
 * **Never leave a non-click-through region overlapping `y < menuBarHeight`
 * outside the notch's own x-range.** That is how you break the menu bar for the
 * entire machine. Main clamps these too; this is the first of the two gates.
 */
function hotRects(): DeskHotRect[] {
  const centreX = windowWidth.value / 2

  if (mode.value === 'rest') {
    return [
      // Above the bar: the notch's own x-range, which owns no menu bar content.
      { x: centreX - restWidth.value / 2, y: 0, width: restWidth.value, height: menuBarHeight.value },
      // Below it: a real target around the hairline.
      {
        x: centreX - REST_HOVER_WIDTH / 2,
        y: menuBarHeight.value,
        width: REST_HOVER_WIDTH,
        height: REST_HOVER_HEIGHT,
      },
    ]
  }

  const width = mode.value === 'open' ? OPEN_WIDTH : mode.value === 'ask' ? ASK_WIDTH : GLANCE_WIDTH
  const height = mode.value === 'open' ? OPEN_MAX_HEIGHT : mode.value === 'ask' ? ASK_HEIGHT : GLANCE_HEIGHT
  return [
    // Keep the notch strip hot so moving up into it does not drop the panel.
    { x: centreX - restWidth.value / 2, y: 0, width: restWidth.value, height: restHeight.value },
    { x: centreX - width / 2, y: menuBarHeight.value, width, height },
  ]
}

function publishHotRects(): void {
  window.desk?.setHotRects(hotRects())
}

// --- hover → Glance ---

/**
 * 400ms, matching Bond's v-tooltip. Top-of-screen is where the cursor goes to
 * reach the menu bar, the traffic lights, and window drags — without a delay it
 * becomes a minefield.
 */
const GLANCE_DELAY_MS = 400
let glanceTimer: ReturnType<typeof setTimeout> | null = null

function clearGlanceTimer(): void {
  if (glanceTimer) { clearTimeout(glanceTimer); glanceTimer = null }
}

watch(hovering, (inside) => {
  clearGlanceTimer()
  // Ask and Open own the surface; hover never overrides them.
  if (mode.value === 'ask' || mode.value === 'open') return
  if (inside) {
    glanceTimer = setTimeout(() => { if (mode.value === 'rest') mode.value = 'glance' }, GLANCE_DELAY_MS)
  } else if (mode.value === 'glance') {
    mode.value = 'rest'
  }
})

// --- data ---

async function refreshStatus(): Promise<void> {
  try {
    status.value = await window.bond.deskStatus()
  } catch {
    // A daemon blip must not blank the panel — keep the last known state.
  }
}

async function refreshPanel(): Promise<void> {
  try {
    const [blocks, allThreads, today] = await Promise.all([
      window.bond.deskInFlight({ limit: 8 }),
      window.bond.deskThreads(),
      window.bond.deskToday(),
    ])
    inFlight.value = blocks
    threads.value = allThreads
    todayItems.value = today.items as TodayItem[]
  } catch {
    // Same: a failed refresh keeps whatever was on screen.
  }
}

/**
 * An Ask drops, holds ~20s, and retracts to a pending hairline. The retract is
 * local only: the question stays pending in the daemon, and silence commits it
 * there, not here.
 */
let askTimer: ReturnType<typeof setTimeout> | null = null

watch(pending, (question) => {
  if (askTimer) { clearTimeout(askTimer); askTimer = null }
  if (!question) {
    if (mode.value === 'ask') mode.value = 'rest'
    return
  }
  // Never yank an open panel out from under someone to ask a question.
  if (mode.value === 'open') return
  mode.value = 'ask'
  askTimer = setTimeout(() => { if (mode.value === 'ask') mode.value = 'rest' }, 20_000)
})

watch(mode, (next) => {
  publishHotRects()
  if (next === 'open') refreshPanel()
  if (next !== 'open') { reassigning.value = null; learned.value = null }
})
watch(geometry, publishHotRects)

// --- actions ---

function toggleOpen(): void {
  clearGlanceTimer()
  mode.value = mode.value === 'open' ? 'rest' : 'open'
}

async function answer(accepted: boolean): Promise<void> {
  const question = pending.value
  if (!question) return
  mode.value = 'rest'
  try {
    await window.bond.deskAnswer(question.id, accepted)
  } finally {
    refreshStatus()
  }
}

/**
 * Reassignment is **optimistic and instant** in the panel; the rule write
 * happens behind it. A Rize reviewer's complaint was exactly this: "it takes a
 * little while to update when you change activity categories, so it's hard to
 * see things reflected instantly."
 */
async function reassign(blockId: string, threadId: string): Promise<void> {
  const block = inFlight.value.find(b => b.id === blockId)
  const thread = threads.value.find(t => t.id === threadId)
  if (block && thread) {
    block.threadId = threadId
    block.thread = thread
  }
  reassigning.value = null
  busy.value = true
  try {
    const result = await window.bond.deskReassign(blockId, threadId)
    // Bond says what it learned once, visibly. Then it stops talking about rules.
    learned.value = result?.learned ?? null
    setTimeout(() => { learned.value = null }, 6_000)
  } finally {
    busy.value = false
    refreshPanel()
    refreshStatus()
  }
}

async function toggleTodo(itemId: string, done: boolean): Promise<void> {
  const item = todayItems.value.find(i => i.id === itemId)
  if (item) (item.data as Record<string, unknown>).status = done ? 'done' : 'todo'
  busy.value = true
  try {
    await window.bond.updateCollectionItem(itemId, { status: done ? 'done' : 'todo' })
  } finally {
    busy.value = false
    refreshPanel()
  }
}

async function addTodo(title: string): Promise<void> {
  busy.value = true
  try {
    const today = await window.bond.deskToday()
    await window.bond.addCollectionItem(today.collectionId, { title, day: today.day, status: 'todo' })
  } finally {
    busy.value = false
    refreshPanel()
  }
}

// --- wiring ---

let offHover: (() => void) | undefined
let offGeometry: (() => void) | undefined
let offDeskChanged: (() => void) | undefined

onMounted(() => {
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
  isDark.value = colorScheme.matches
  colorScheme.addEventListener('change', e => { isDark.value = e.matches })

  offHover = window.desk?.onHover(inside => { hovering.value = inside })
  offGeometry = window.desk?.onGeometry(next => { geometry.value = next })
  offDeskChanged = window.bond.onDeskChanged(() => {
    refreshStatus()
    if (mode.value === 'open') refreshPanel()
  })

  window.addEventListener('keydown', onKeydown)
  window.desk?.ready()
  refreshStatus()
  publishHotRects()
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (mode.value === 'open' || mode.value === 'ask') mode.value = 'rest'
}

onUnmounted(() => {
  offHover?.()
  offGeometry?.()
  offDeskChanged?.()
  window.removeEventListener('keydown', onKeydown)
  clearGlanceTimer()
  if (askTimer) clearTimeout(askTimer)
})
</script>

<template>
  <div class="desk-root">
    <div
      class="desk-shape"
      :class="[`is-${mode}`, { 'is-hovering': hovering, 'is-uncertain': uncertain, 'is-dropped': dropped }]"
      :style="shapeStyle"
    >
      <!-- Rest: three channels in a hairline — presence, thread colour, uncertainty. -->
      <button
        v-if="mode === 'rest'"
        type="button"
        class="desk-rest"
        aria-label="Open Desk"
        @click="toggleOpen"
      >
        <span class="desk-mark" :style="markStyle" />
      </button>

      <!-- Glance: thread + coarse time. Make-aware, no action wanted. -->
      <button v-else-if="mode === 'glance'" type="button" class="desk-glance" @click="toggleOpen">
        <span class="desk-dot" :style="threadColor ? { background: threadColor } : undefined" />
        <span class="desk-glance-name">{{ currentName ?? 'Nothing yet' }}</span>
        <span v-if="currentName" class="desk-glance-time">{{ currentElapsed }}</span>
      </button>

      <!-- Ask: one line, two answers. Never a modal, never an interrupt. -->
      <div v-else-if="mode === 'ask'" class="desk-ask">
        <span class="desk-ask-text">{{ askText }}</span>
        <div class="desk-ask-actions">
          <button type="button" class="desk-btn is-yes" @click="answer(true)">Yes</button>
          <button type="button" class="desk-btn" @click="answer(false)">No</button>
        </div>
      </div>

      <!-- Open: two lists, kept structurally separate. -->
      <div v-else class="desk-panel">
        <header class="desk-panel-head">
          <span class="desk-dot" :style="threadColor ? { background: threadColor } : undefined" />
          <span class="desk-panel-now">{{ currentName ?? 'Nothing in flight' }}</span>
          <span v-if="currentName" class="desk-glance-time">{{ currentElapsed }}</span>
          <button type="button" class="desk-close" aria-label="Close Desk panel" @click="toggleOpen">&times;</button>
        </header>

        <p v-if="learned" class="desk-learned">{{ learned }}</p>
        <p v-else-if="status && !status.senseEnabled" class="desk-learned is-muted">
          Sense is off — showing past threads only.
        </p>
        <p v-else-if="status?.backfilling" class="desk-learned is-muted">Catching up on today…</p>

        <section class="desk-section">
          <h2 class="desk-section-title">In flight</h2>
          <DeskInFlight
            :blocks="inFlight"
            :threads="threads"
            :is-dark="isDark"
            :reassigning="reassigning"
            :busy="busy"
            @open-picker="reassigning = $event"
            @reassign="reassign"
          />
        </section>

        <section class="desk-section">
          <h2 class="desk-section-title">Today</h2>
          <DeskToday :items="todayItems" :busy="busy" @toggle="toggleTodo" @add="addTodo" />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.desk-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: transparent;
}

.desk-shape {
  position: fixed;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e8eaed;
  pointer-events: auto;
  will-change: transform, opacity;
  /* Compositor-only. No width/height/clip-path animation, no spring, no bounce. */
  transform: translateX(-50%) translateY(0);
  transition:
    transform 0.38s cubic-bezier(0.32, 0.72, 0, 1),
    opacity 0.38s cubic-bezier(0.32, 0.72, 0, 1);
}

/* At rest NOTHING paints but the hairline — the notch is already dead black,
   and adding a rectangle to it is what "costs zero pixels" exists to avoid. */
.desk-shape.is-rest {
  background: transparent;
  filter: none;
}

.desk-shape.is-dropped {
  background: rgba(16, 17, 20, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-top: 0;
  filter: drop-shadow(0 10px 26px rgba(0, 0, 0, 0.5));
  align-items: stretch;
  overflow: hidden;
}

.desk-shape.is-uncertain .desk-mark {
  opacity: 0.35;
}

.desk-shape.is-hovering .desk-mark {
  opacity: 1;
}

.desk-rest {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.desk-mark {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: block;
  width: 44px;
  height: 3px;
  border-radius: 999px;
  background: #8b939e;
  transition: opacity 0.38s cubic-bezier(0.32, 0.72, 0, 1);
}

.desk-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #8b939e;
}

/* --- Glance --- */

.desk-glance {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  height: 100%;
  padding: 0 0.875rem;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
}

.desk-glance-name {
  font: 500 12px/1.2 var(--font-sans, system-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  text-align: left;
}

.desk-glance-time {
  font: 400 11px/1.2 var(--font-sans, system-ui);
  opacity: 0.5;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* --- Ask --- */

.desk-ask {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  height: 100%;
  padding: 0 0.875rem;
}

.desk-ask-text {
  font: 500 12px/1.2 var(--font-sans, system-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.desk-ask-actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.desk-btn {
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font: 500 11px/1 var(--font-sans, system-ui);
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}

.desk-btn:hover { background: rgba(255, 255, 255, 0.16); }
.desk-btn.is-yes { background: rgba(255, 255, 255, 0.2); }

/* --- Open --- */

.desk-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 0.5rem;
  gap: 0.5rem;
  overflow-y: auto;
}

.desk-panel-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.125rem 0.5rem 0.375rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.desk-panel-now {
  font: 600 12px/1.3 var(--font-sans, system-ui);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.desk-close {
  background: transparent;
  border: 0;
  color: inherit;
  opacity: 0.45;
  font-size: 15px;
  line-height: 1;
  padding: 0 0.125rem;
  cursor: pointer;
}

.desk-close:hover { opacity: 1; }

.desk-learned {
  margin: 0;
  padding: 0.375rem 0.5rem;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  font: 400 11px/1.35 var(--font-sans, system-ui);
}

.desk-learned.is-muted { background: transparent; opacity: 0.5; }

.desk-section {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.desk-section-title {
  margin: 0 0 0.125rem;
  padding: 0 0.5rem;
  font: 600 10px/1.4 var(--font-sans, system-ui);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.4;
}

/* Peek, Glance, Ask, and Open all collapse to instant state changes. */
@media (prefers-reduced-motion: reduce) {
  .desk-shape,
  .desk-mark {
    transition: none;
  }
}
</style>
