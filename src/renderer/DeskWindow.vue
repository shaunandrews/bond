<script setup lang="ts">
/**
 * Desk — the notch-anchored panel. Phase 3: **Rest and Ask only.**
 *
 * The window itself is created once at fully-expanded size, positioned once,
 * and never resized. `win.setBounds(bounds, true)` blocks the main process for
 * ~340ms — it is a synchronous, fixed-duration `NSWindow setFrame:display:`
 * that cannot be interrupted or retargeted, and resizing a transparent window
 * per-frame is the exact path that produces the known flicker artifacts.
 *
 * So every bit of motion here is a CSS `transform` on a child element inside a
 * fixed rect. Compositor-only: `transform` and `opacity`, nothing else.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { appColor } from './composables/useSense'
import type { DeskStatus } from '../shared/desk'
import type { DeskWindowGeometry, DeskHotRect } from '../shared/desk-window'

const geometry = ref<DeskWindowGeometry | null>(null)
const status = ref<DeskStatus | null>(null)
const hovering = ref(false)
const isDark = ref(false)

/** Rest → Ask. No Glance, no Open panel; those are Phase 4. */
type Mode = 'rest' | 'ask'
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
// Default matches restShape(): menu bar + the strip the hairline lives in.
const restHeight = computed(() => geometry.value?.restHeight ?? 41)
const menuBarHeight = computed(() => geometry.value?.menuBarHeight ?? 33)
const notched = computed(() => geometry.value?.notched ?? false)

/** The Ask lozenge sits below the menu bar — never over it. */
const askWidth = 360
const askHeight = 44

const shapeStyle = computed(() => ({
  width: `${mode.value === 'ask' ? askWidth : restWidth.value}px`,
  height: `${mode.value === 'ask' ? askHeight : restHeight.value}px`,
  // The Ask lozenge is the only thing that ever paints a background, and it
  // starts below the menu bar so it is never occluded by the notch.
  top: mode.value === 'ask' ? `${menuBarHeight.value}px` : '0px',
  borderRadius: mode.value === 'ask' ? '0 0 12px 12px' : '0',
}))

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
  const centreX = (geometry.value?.windowWidth ?? 640) / 2

  if (mode.value === 'ask') {
    return [{
      x: centreX - askWidth / 2,
      y: menuBarHeight.value,
      width: askWidth,
      height: askHeight,
    }]
  }

  // At rest the only interactive rectangle above the menu bar is the physical
  // notch x-range, which owns no menu bar content anyway.
  return [{
    x: centreX - restWidth.value / 2,
    y: 0,
    width: restWidth.value,
    height: restHeight.value,
  }]
}

function publishHotRects(): void {
  window.desk?.setHotRects(hotRects())
}

// --- wiring ---

let offHover: (() => void) | undefined
let offGeometry: (() => void) | undefined
let offDeskChanged: (() => void) | undefined
let colorScheme: MediaQueryList | undefined

async function refreshStatus(): Promise<void> {
  try {
    status.value = await window.bond.deskStatus()
  } catch {
    // A daemon blip must not blank the panel — keep the last known state.
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
    mode.value = 'rest'
    return
  }
  mode.value = 'ask'
  askTimer = setTimeout(() => { mode.value = 'rest' }, 20_000)
})

watch(mode, publishHotRects)
watch(geometry, publishHotRects)

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

onMounted(() => {
  colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
  isDark.value = colorScheme.matches
  colorScheme.addEventListener('change', e => { isDark.value = e.matches })

  offHover = window.desk?.onHover(inside => { hovering.value = inside })
  offGeometry = window.desk?.onGeometry(next => { geometry.value = next })
  offDeskChanged = window.bond.onDeskChanged(() => refreshStatus())

  window.desk?.ready()
  refreshStatus()
  publishHotRects()
})

onUnmounted(() => {
  offHover?.()
  offGeometry?.()
  offDeskChanged?.()
  if (askTimer) clearTimeout(askTimer)
})
</script>

<template>
  <div class="desk-root">
    <div
      class="desk-shape"
      :class="[`is-${mode}`, { 'is-hovering': hovering, 'is-uncertain': uncertain }]"
      :style="shapeStyle"
    >
      <!-- Rest: three channels in a hairline — presence, thread colour, uncertainty. -->
      <div v-if="mode === 'rest'" class="desk-rest">
        <span class="desk-mark" :style="markStyle" />
      </div>

      <!-- Ask: one line, two answers. Never a modal, never an interrupt. -->
      <div v-else class="desk-ask">
        <span class="desk-ask-text">{{ askText }}</span>
        <div class="desk-ask-actions">
          <button type="button" class="desk-btn is-yes" @click="answer(true)">Yes</button>
          <button type="button" class="desk-btn" @click="answer(false)">No</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.desk-root {
  position: fixed;
  inset: 0;
  /* Transparent padding for the CSS shadow bleed. hasShadow is false because
     native shadows do not render on transparent windows. */
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
  filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.45));
}

.desk-shape.is-rest {
  /* At rest NOTHING paints but the hairline itself — no box, no shadow. The
     notch is already dead black; adding a rectangle to it is what "costs zero
     pixels" is meant to avoid. */
  background: transparent;
  filter: none;
}

.desk-shape.is-uncertain .desk-mark {
  opacity: 0.35;
}

.desk-shape.is-ask {
  /* Drops clear of the menu bar — `top` is set inline from menuBarHeight. */
  background: #000;
  transform: translateX(-50%) translateY(0);
  padding: 0 0.75rem;
  gap: 0.75rem;
}

.desk-rest {
  position: relative;
  width: 100%;
  height: 100%;
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

.desk-shape.is-hovering .desk-mark {
  opacity: 1;
}

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

.desk-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}

.desk-btn.is-yes {
  background: rgba(255, 255, 255, 0.2);
}

/* Peek and Ask collapse to instant state changes. */
@media (prefers-reduced-motion: reduce) {
  .desk-shape,
  .desk-mark {
    transition: none;
  }
}
</style>
