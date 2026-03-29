import { ref, onMounted, onUnmounted, type Ref } from 'vue'

const THRESHOLD = 50 // pixels from bottom to count as "at bottom"

export function useAutoScroll(containerRef: Ref<HTMLElement | null>) {
  const isAtBottom = ref(true)
  let mutationObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null

  function checkIfAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - (el.scrollTop + el.clientHeight) <= THRESHOLD
  }

  function onScroll() {
    const el = containerRef.value
    if (!el) return
    isAtBottom.value = checkIfAtBottom(el)
  }

  function scrollToBottom() {
    const el = containerRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    isAtBottom.value = true
  }

  function autoScroll() {
    if (isAtBottom.value) {
      scrollToBottom()
    }
  }

  onMounted(() => {
    const el = containerRef.value
    if (!el) return

    el.addEventListener('scroll', onScroll, { passive: true })

    // Watch for any DOM changes inside the container (new messages, streaming text)
    mutationObserver = new MutationObserver(autoScroll)
    mutationObserver.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    // Watch direct children for size changes (images loading, content reflowing)
    resizeObserver = new ResizeObserver(autoScroll)
    for (const child of el.children) {
      resizeObserver.observe(child)
    }
  })

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', onScroll)
    mutationObserver?.disconnect()
    resizeObserver?.disconnect()
  })

  return { isAtBottom, scrollToBottom }
}
