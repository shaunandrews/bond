import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, createApp, defineComponent } from 'vue'
import { useAutoScroll } from './useAutoScroll'

function mountWithAutoScroll(container: HTMLElement) {
  const containerRef = ref<HTMLElement | null>(container)
  let result!: ReturnType<typeof useAutoScroll>

  const app = createApp(
    defineComponent({
      setup() {
        result = useAutoScroll(containerRef)
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useAutoScroll', () => {
  let container: HTMLDivElement
  let content: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    content = document.createElement('div')
    container.appendChild(content)
    document.body.appendChild(container)

    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 400, configurable: true })
    container.scrollTop = 0
  })

  it('starts with isAtBottom true', () => {
    const { isAtBottom } = mountWithAutoScroll(container)
    expect(isAtBottom.value).toBe(true)
  })

  it('sets isAtBottom to false when user scrolls up', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    container.scrollTop = 200

    const { isAtBottom } = mountWithAutoScroll(container)

    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(false)
  })

  it('sets isAtBottom back to true when user scrolls to bottom', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    container.scrollTop = 200

    const { isAtBottom } = mountWithAutoScroll(container)

    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(false)

    // Scroll within threshold of bottom (1000 - 400 = 600 max scrollTop, threshold 50)
    container.scrollTop = 570
    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(true)
  })

  it('scrollToBottom sets scrollTop to scrollHeight', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    expect(container.scrollTop).toBe(1000)
  })
})
