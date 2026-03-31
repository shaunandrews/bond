import type { Directive, DirectiveBinding } from 'vue'

// --- Types ---

type Placement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipOptions {
  content: string
  placement?: Placement
}

type TooltipBinding = string | TooltipOptions

// --- Constants ---

const SHOW_DELAY = 400
const SKIP_DELAY = 80
const HIDE_DELAY = 100
const SKIP_WINDOW = 500
const GAP = 6
const VIEWPORT_PAD = 6

// --- Singleton State ---

let tooltipEl: HTMLElement | null = null
let arrowEl: HTMLElement | null = null
let textEl: HTMLElement | null = null

let activeTrigger: HTMLElement | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let lastHideTime = 0
let tooltipId = 0

// Store per-element state
const elState = new WeakMap<HTMLElement, {
  content: string
  placement: Placement
  id: string
  onEnter: () => void
  onLeave: () => void
  onFocusIn: () => void
  onFocusOut: () => void
  onKeyDown: (e: KeyboardEvent) => void
}>()

// --- DOM ---

function ensureTooltipEl(): HTMLElement {
  if (tooltipEl) return tooltipEl

  tooltipEl = document.createElement('div')
  tooltipEl.className = 'bond-tooltip'
  tooltipEl.setAttribute('role', 'tooltip')

  textEl = document.createElement('span')
  tooltipEl.appendChild(textEl)

  arrowEl = document.createElement('span')
  arrowEl.className = 'bond-tooltip__arrow'
  tooltipEl.appendChild(arrowEl)

  document.body.appendChild(tooltipEl)

  // Dismiss on scroll anywhere
  document.addEventListener('scroll', hideImmediate, { capture: true, passive: true })

  return tooltipEl
}

// --- Positioning ---

function position(trigger: HTMLElement, placement: Placement) {
  const el = ensureTooltipEl()
  const rect = trigger.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  let resolvedPlacement = placement
  let top = 0
  let left = 0

  // Try preferred placement, flip if it overflows
  if (resolvedPlacement === 'top') {
    top = rect.top - GAP - elRect.height
    if (top < VIEWPORT_PAD) {
      resolvedPlacement = 'bottom'
      top = rect.bottom + GAP
    }
  } else if (resolvedPlacement === 'bottom') {
    top = rect.bottom + GAP
    if (top + elRect.height > vh - VIEWPORT_PAD) {
      resolvedPlacement = 'top'
      top = rect.top - GAP - elRect.height
    }
  } else if (resolvedPlacement === 'left') {
    left = rect.left - GAP - elRect.width
    if (left < VIEWPORT_PAD) {
      resolvedPlacement = 'right'
      left = rect.right + GAP
    }
  } else if (resolvedPlacement === 'right') {
    left = rect.right + GAP
    if (left + elRect.width > vw - VIEWPORT_PAD) {
      resolvedPlacement = 'left'
      left = rect.left - GAP - elRect.width
    }
  }

  // Center on the cross axis
  if (resolvedPlacement === 'top' || resolvedPlacement === 'bottom') {
    left = rect.left + rect.width / 2 - elRect.width / 2
    left = Math.max(VIEWPORT_PAD, Math.min(left, vw - elRect.width - VIEWPORT_PAD))
  } else {
    top = rect.top + rect.height / 2 - elRect.height / 2
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - elRect.height - VIEWPORT_PAD))
  }

  el.style.top = `${top}px`
  el.style.left = `${left}px`

  // Arrow positioning
  if (arrowEl) {
    arrowEl.dataset.placement = resolvedPlacement

    if (resolvedPlacement === 'top' || resolvedPlacement === 'bottom') {
      const arrowLeft = rect.left + rect.width / 2 - left
      arrowEl.style.left = `${Math.max(6, Math.min(arrowLeft, elRect.width - 6))}px`
      arrowEl.style.top = ''
    } else {
      const arrowTop = rect.top + rect.height / 2 - top
      arrowEl.style.top = `${Math.max(6, Math.min(arrowTop, elRect.height - 6))}px`
      arrowEl.style.left = ''
    }
  }
}

// --- Show / Hide ---

function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

function show(trigger: HTMLElement) {
  const state = elState.get(trigger)
  if (!state) return

  clearTimers()
  activeTrigger = trigger

  const el = ensureTooltipEl()
  textEl!.textContent = state.content
  el.id = state.id
  trigger.setAttribute('aria-describedby', state.id)

  // Make visible but transparent so we can measure
  el.style.visibility = 'hidden'
  el.classList.remove('visible')
  el.style.display = 'block'

  // Position after layout
  requestAnimationFrame(() => {
    if (activeTrigger !== trigger) return
    position(trigger, state.placement)
    el.style.visibility = ''
    // Trigger transition on next frame
    requestAnimationFrame(() => {
      if (activeTrigger !== trigger) return
      el.classList.add('visible')
    })
  })
}

function hide() {
  if (!tooltipEl || !activeTrigger) return

  const trigger = activeTrigger
  trigger.removeAttribute('aria-describedby')

  tooltipEl.classList.remove('visible')
  activeTrigger = null
  lastHideTime = Date.now()

  // Hide after transition completes
  setTimeout(() => {
    if (!activeTrigger && tooltipEl) {
      tooltipEl.style.display = 'none'
    }
  }, 150)
}

function hideImmediate() {
  clearTimers()
  if (!tooltipEl || !activeTrigger) return

  activeTrigger.removeAttribute('aria-describedby')
  tooltipEl.classList.remove('visible')
  tooltipEl.style.display = 'none'
  activeTrigger = null
  lastHideTime = Date.now()
}

function scheduleShow(trigger: HTMLElement) {
  clearTimers()

  // If we're showing on a different trigger, hide the current one instantly
  if (activeTrigger && activeTrigger !== trigger) {
    hideImmediate()
  }

  const elapsed = Date.now() - lastHideTime
  const delay = elapsed < SKIP_WINDOW ? SKIP_DELAY : SHOW_DELAY

  showTimer = setTimeout(() => show(trigger), delay)
}

function scheduleHide() {
  clearTimers()
  hideTimer = setTimeout(hide, HIDE_DELAY)
}

// --- Helpers ---

function resolve(binding: DirectiveBinding<TooltipBinding>): { content: string; placement: Placement } {
  const val = binding.value
  let content = ''
  let placement: Placement = 'top'

  if (typeof val === 'string') {
    content = val
  } else if (val && typeof val === 'object') {
    content = val.content
    if (val.placement) placement = val.placement
  }

  // Modifier overrides object placement
  if (binding.modifiers.top) placement = 'top'
  else if (binding.modifiers.bottom) placement = 'bottom'
  else if (binding.modifiers.left) placement = 'left'
  else if (binding.modifiers.right) placement = 'right'

  return { content, placement }
}

// --- Setup ---

function setup(el: HTMLElement, content: string, placement: Placement) {
  // Remove native title if present
  el.removeAttribute('title')

  const id = `bond-tooltip-${++tooltipId}`

  const onEnter = () => scheduleShow(el)
  const onLeave = () => scheduleHide()
  const onFocusIn = () => scheduleShow(el)
  const onFocusOut = () => scheduleHide()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && activeTrigger === el) {
      hideImmediate()
    }
  }

  elState.set(el, { content, placement, id, onEnter, onLeave, onFocusIn, onFocusOut, onKeyDown })

  el.addEventListener('mouseenter', onEnter)
  el.addEventListener('mouseleave', onLeave)
  el.addEventListener('focusin', onFocusIn)
  el.addEventListener('focusout', onFocusOut)
  el.addEventListener('keydown', onKeyDown)
}

// --- Directive ---

export const vTooltip: Directive<HTMLElement, TooltipBinding> = {
  mounted(el, binding) {
    const { content, placement } = resolve(binding)
    if (!content) return
    setup(el, content, placement)
  },

  updated(el, binding) {
    const { content, placement } = resolve(binding)
    const state = elState.get(el)

    if (!content) {
      // Content cleared — remove tooltip behavior
      if (state) {
        if (activeTrigger === el) hideImmediate()
        el.removeEventListener('mouseenter', state.onEnter)
        el.removeEventListener('mouseleave', state.onLeave)
        el.removeEventListener('focusin', state.onFocusIn)
        el.removeEventListener('focusout', state.onFocusOut)
        el.removeEventListener('keydown', state.onKeyDown)
        elState.delete(el)
      }
      return
    }

    if (state) {
      state.content = content
      state.placement = placement

      // Update live tooltip if this trigger is active
      if (activeTrigger === el && textEl) {
        textEl.textContent = content
        position(el, placement)
      }
    } else {
      // Content appeared — set up fresh
      setup(el, content, placement)
    }
  },

  unmounted(el) {
    const state = elState.get(el)
    if (!state) return

    if (activeTrigger === el) hideImmediate()

    el.removeEventListener('mouseenter', state.onEnter)
    el.removeEventListener('mouseleave', state.onLeave)
    el.removeEventListener('focusin', state.onFocusIn)
    el.removeEventListener('focusout', state.onFocusOut)
    el.removeEventListener('keydown', state.onKeyDown)
    el.removeAttribute('aria-describedby')
    elState.delete(el)
  },
}
