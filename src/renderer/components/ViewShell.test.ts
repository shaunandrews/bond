import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ViewShell from './ViewShell.vue'

describe('ViewShell', () => {
  it('always renders the header-left slot when provided', () => {
    const wrapper = mount(ViewShell, {
      props: { title: 'Test' },
      slots: {
        'header-left': '<button class="sidebar-toggle-btn">Toggle</button>',
      },
    })

    expect(wrapper.find('.view-header-left').exists()).toBe(true)
    expect(wrapper.find('.sidebar-toggle-btn').exists()).toBe(true)
  })

  it('does not render header-left wrapper when slot is empty', () => {
    const wrapper = mount(ViewShell, {
      props: { title: 'Test' },
    })

    expect(wrapper.find('.view-header-left').exists()).toBe(false)
  })

  it('header-left is inside the view-header', () => {
    const wrapper = mount(ViewShell, {
      props: { title: 'Test' },
      slots: {
        'header-left': '<button class="toggle">T</button>',
      },
    })

    const header = wrapper.find('.view-header')
    expect(header.find('.view-header-left').exists()).toBe(true)
  })
})
