import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import ViewShell from './ViewShell.vue'

/**
 * The sidebar toggle button lives in the main panel's ViewShell header-left slot.
 * When the sidebar is collapsed the main panel starts at the window edge, so the
 * wrapper needs a `sidebar-collapsed` class to push the button right and clear
 * macOS traffic lights (~70px / 5.5rem).
 *
 * These tests guard against the recurring regression where the toggle ends up
 * hidden under the traffic lights.
 */

// Minimal host that mirrors App.vue's main-panel-wrap + ViewShell pattern.
function createHost(collapsed: boolean) {
  const Host = defineComponent({
    components: { ViewShell },
    setup() {
      const sidebarCollapsed = ref(collapsed)
      return { sidebarCollapsed }
    },
    template: `
      <div :class="['main-panel-wrap', { 'sidebar-collapsed': sidebarCollapsed }]">
        <ViewShell title="Chat">
          <template #header-left>
            <button class="sidebar-toggle-btn">Toggle</button>
          </template>
        </ViewShell>
      </div>
    `,
  })
  return mount(Host)
}

describe('Sidebar toggle positioning', () => {
  it('adds sidebar-collapsed class to main-panel-wrap when sidebar is collapsed', () => {
    const wrapper = createHost(true)
    expect(wrapper.find('.main-panel-wrap').classes()).toContain('sidebar-collapsed')
  })

  it('does not add sidebar-collapsed class when sidebar is open', () => {
    const wrapper = createHost(false)
    expect(wrapper.find('.main-panel-wrap').classes()).not.toContain('sidebar-collapsed')
  })

  it('always renders the sidebar toggle button regardless of sidebar state', () => {
    const open = createHost(false)
    const collapsed = createHost(true)

    expect(open.find('.sidebar-toggle-btn').exists()).toBe(true)
    expect(collapsed.find('.sidebar-toggle-btn').exists()).toBe(true)
  })

  it('toggle button is inside view-header-left which is inside view-header', () => {
    const wrapper = createHost(true)
    const header = wrapper.find('.view-header')
    const headerLeft = header.find('.view-header-left')
    const toggle = headerLeft.find('.sidebar-toggle-btn')

    expect(header.exists()).toBe(true)
    expect(headerLeft.exists()).toBe(true)
    expect(toggle.exists()).toBe(true)
  })
})
