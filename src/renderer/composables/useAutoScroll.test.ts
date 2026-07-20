import { describe, it, expect, beforeEach } from 'vitest'
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

function wheelEvent(deltaY: number): Event {
  return Object.assign(new Event('wheel'), { deltaY })
}

function touchEvent(type: string, clientY: number): Event {
  return Object.assign(new Event(type), { touches: [{ clientY }] })
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
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.scrollTop = 200
    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(false)
  })

  it('sets isAtBottom back to true when user scrolls to bottom', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.scrollTop = 200
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

  it('stays pinned when streamed content grows before our scroll event lands', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    expect(isAtBottom.value).toBe(true)

    // The browser delivers the scroll event from our own scrollToBottom, but
    // streaming grew scrollHeight in between so the position is no longer
    // geometrically at the bottom. Not an upward move → must stay pinned.
    Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(true)
  })

  it('unpins on an upward scroll even right after a programmatic scroll', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    // Regression: the old skipNextScroll flag ate the user's scroll event
    // when it landed directly after a programmatic scroll, leaving the user
    // pinned and yanked back down on the next streamed chunk.
    scrollToBottom()
    container.scrollTop = 300
    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(false)
  })

  it('unpins immediately on wheel-up, before any scroll event', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.dispatchEvent(wheelEvent(-10))
    expect(isAtBottom.value).toBe(false)
  })

  it('does not unpin on wheel-down', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.dispatchEvent(wheelEvent(10))
    expect(isAtBottom.value).toBe(true)
  })

  it('ignores wheel-up when the content does not scroll', () => {
    // scrollHeight equals clientHeight — nothing to scroll, nothing to unpin
    const { isAtBottom } = mountWithAutoScroll(container)

    container.dispatchEvent(wheelEvent(-10))
    expect(isAtBottom.value).toBe(true)
  })

  it('unpins when a touch pan moves the content up', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.dispatchEvent(touchEvent('touchstart', 200))
    container.dispatchEvent(touchEvent('touchmove', 260))
    expect(isAtBottom.value).toBe(false)
  })

  it('does not unpin when a touch pan moves the content down', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.dispatchEvent(touchEvent('touchstart', 200))
    container.dispatchEvent(touchEvent('touchmove', 140))
    expect(isAtBottom.value).toBe(true)
  })

  it('does not re-pin when a wheel-up lands within the bottom threshold', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    // Regression: one wheel click up from the bottom moved the user less
    // than THRESHOLD, so the resulting scroll event re-pinned them and the
    // next streamed chunk yanked them back down.
    scrollToBottom()
    container.dispatchEvent(wheelEvent(-10))
    expect(isAtBottom.value).toBe(false)

    // 1000 - (580 + 400) = 20px from bottom — inside the threshold, but
    // the movement was upward, so it must stay unpinned.
    container.scrollTop = 580
    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(false)

    // Scrolling down into the bottom zone re-pins.
    container.scrollTop = 600
    container.dispatchEvent(new Event('scroll'))
    expect(isAtBottom.value).toBe(true)
  })

  it('unpins on upward keyboard navigation', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    scrollToBottom()
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
    expect(isAtBottom.value).toBe(false)
  })

  it('scrollToBottom re-pins after the user scrolled away', () => {
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    const { isAtBottom, scrollToBottom } = mountWithAutoScroll(container)

    container.dispatchEvent(wheelEvent(-10))
    expect(isAtBottom.value).toBe(false)

    scrollToBottom()
    expect(isAtBottom.value).toBe(true)
    expect(container.scrollTop).toBe(1000)
  })
})
