import { ref, onMounted, onUnmounted, type Ref } from 'vue'

const THRESHOLD = 50 // pixels from bottom to count as "at bottom"

export function useAutoScroll(containerRef: Ref<HTMLElement | null>) {
  const isAtBottom = ref(true)
  let mutationObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null
  let lastScrollTop = 0
  let touchStartY = 0

  function checkIfAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - (el.scrollTop + el.clientHeight) <= THRESHOLD
  }

  function canScroll(el: HTMLElement): boolean {
    return el.scrollHeight > el.clientHeight
  }

  // Unpinning is driven by input events (wheel/touch/keys), not scroll
  // position: during streaming, autoScroll yanks the position back to the
  // bottom before the user's scroll is ever observed, so position alone
  // can't distinguish "user scrolled up" from "we scrolled down".
  function onWheel(e: WheelEvent) {
    const el = containerRef.value
    if (!el || !canScroll(el)) return
    if (e.deltaY < 0) isAtBottom.value = false
  }

  function onTouchStart(e: TouchEvent) {
    touchStartY = e.touches[0]?.clientY ?? 0
  }

  function onTouchMove(e: TouchEvent) {
    const el = containerRef.value
    if (!el || !canScroll(el)) return
    const y = e.touches[0]?.clientY ?? touchStartY
    // Finger moving down pans the content up
    if (y > touchStartY) isAtBottom.value = false
  }

  function onKeyDown(e: KeyboardEvent) {
    const el = containerRef.value
    if (!el || !canScroll(el)) return
    if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
      isAtBottom.value = false
    }
  }

  function onScroll() {
    const el = containerRef.value
    if (!el) return
    const top = el.scrollTop
    if (checkIfAtBottom(el)) {
      // Re-pin only on downward movement into the bottom zone. An upward
      // scroll that still lands within the threshold (one wheel click from
      // the bottom) must NOT re-pin — the user just asked to leave.
      if (top > lastScrollTop) isAtBottom.value = true
    } else if (top < lastScrollTop) {
      // Moved up. Our own scrolls only ever go down, so this is the user —
      // covers scrollbar drags, which produce no wheel/touch events.
      isAtBottom.value = false
    }
    // Down-but-not-at-bottom keeps the current state: either the user is
    // heading back down, or our scroll is racing freshly streamed content
    // that grew scrollHeight before this event was delivered.
    lastScrollTop = top
  }

  function scrollToBottom() {
    const el = containerRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTop = el.scrollTop
    isAtBottom.value = true
  }

  function autoScroll() {
    if (isAtBottom.value) {
      scrollToBottom()
    }
  }

  function observeChild(child: Element) {
    resizeObserver?.observe(child)
  }

  onMounted(() => {
    const el = containerRef.value
    if (!el) return

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    lastScrollTop = el.scrollTop

    // Watch direct children for size changes (images loading, content reflowing)
    resizeObserver = new ResizeObserver(autoScroll)
    for (const child of el.children) {
      resizeObserver.observe(child)
    }

    // Watch for any DOM changes inside the container (new messages, streaming text)
    mutationObserver = new MutationObserver((mutations) => {
      // Register any newly-added direct children with the ResizeObserver
      for (const m of mutations) {
        if (m.type === 'childList' && m.target === el) {
          for (const node of m.addedNodes) {
            if (node instanceof Element) {
              observeChild(node)
            }
          }
        }
      }
      autoScroll()
    })
    mutationObserver.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  })

  onUnmounted(() => {
    const el = containerRef.value
    if (el) {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
    }
    mutationObserver?.disconnect()
    resizeObserver?.disconnect()
  })

  return { isAtBottom, scrollToBottom }
}
