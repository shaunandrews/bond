import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ViewShell from './ViewShell.vue'

describe('ViewShell', () => {
  it('always renders the header-start slot when provided', () => {
    const wrapper = mount(ViewShell, {
      props: { title: 'Test' },
      slots: {
        'header-start': '<button class="sidebar-toggle-btn">Toggle</button>',
      },
    })

    expect(wrapper.find('.bond-toolbar__start').exists()).toBe(true)
    expect(wrapper.find('.sidebar-toggle-btn').exists()).toBe(true)
  })

  it('does not render start wrapper when slot is empty', () => {
    const wrapper = mount(ViewShell, {
      props: { title: 'Test' },
    })

    expect(wrapper.find('.bond-toolbar__start').exists()).toBe(false)
  })

  it('only enables header blur after scrolling', async () => {
    const wrapper = mount(ViewShell, { props: { title: 'Test' } })
    const scrollArea = wrapper.find('.view-scroll-area')

    expect(wrapper.find('.bond-toolbar--blur').exists()).toBe(false)
    Object.defineProperty(scrollArea.element, 'scrollTop', { value: 20, configurable: true })
    await scrollArea.trigger('scroll')
    expect(wrapper.find('.bond-toolbar--blur').exists()).toBe(true)
  })

  it('header-start is inside the toolbar which is inside view-header', () => {
    const wrapper = mount(ViewShell, {
      props: { title: 'Test' },
      slots: {
        'header-start': '<button class="toggle">T</button>',
      },
    })

    const header = wrapper.find('.view-header')
    expect(header.find('.bond-toolbar__start').exists()).toBe(true)
  })
})
