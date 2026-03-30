import { ref, onMounted, onUnmounted, type Ref } from 'vue'

const THRESHOLD = 50 // pixels from bottom to count as "at bottom"

export function useAutoScroll(containerRef: Ref<HTMLElement | null>) {
  const isAtBottom = ref(true)
  let mutationObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null
  let skipNextScroll = false

  function checkIfAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - (el.scrollTop + el.clientHeight) <= THRESHOLD
  }

  function onScroll() {
    // Ignore scroll events triggered by our own programmatic scrolls,
    // so streaming content doesn't flip isAtBottom to false mid-stream.
    if (skipNextScroll) {
      skipNextScroll = false
      return
    }
    const el = containerRef.value
    if (!el) return
    isAtBottom.value = checkIfAtBottom(el)
  }

  function scrollToBottom() {
    const el = containerRef.value
    if (!el) return
    skipNextScroll = true
    el.scrollTop = el.scrollHeight
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
    containerRef.value?.removeEventListener('scroll', onScroll)
    mutationObserver?.disconnect()
    resizeObserver?.disconnect()
  })

  return { isAtBottom, scrollToBottom }
}
