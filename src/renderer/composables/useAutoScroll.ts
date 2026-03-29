import { ref, onMounted, onUnmounted, type Ref } from 'vue'

const THRESHOLD = 50 // pixels from bottom to count as "at bottom"

export function useAutoScroll(containerRef: Ref<HTMLElement | null>) {
  const isAtBottom = ref(true)
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

  onMounted(() => {
    const el = containerRef.value
    if (!el) return

    el.addEventListener('scroll', onScroll, { passive: true })

    // Watch the inner content for size changes (new messages, streaming text, images loading)
    const content = el.firstElementChild as HTMLElement | null
    if (content) {
      resizeObserver = new ResizeObserver(() => {
        if (isAtBottom.value) {
          scrollToBottom()
        }
      })
      resizeObserver.observe(content)
    }
  })

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', onScroll)
    resizeObserver?.disconnect()
  })

  return { isAtBottom, scrollToBottom }
}
