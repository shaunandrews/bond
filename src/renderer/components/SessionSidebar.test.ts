import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SessionSidebar from './SessionSidebar.vue'
import type { Session } from '../../shared/session'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'sess-1',
    title: overrides.title ?? 'Test Chat',
    createdAt: overrides.createdAt ?? '2026-03-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-03-01T00:00:00Z',
    archived: overrides.archived ?? false,
    editMode: overrides.editMode ?? { type: 'full' },
  }
}

const defaultProps = {
  sessions: [makeSession()],
  archivedSessions: [
    makeSession({ id: 'arch-1', title: 'Archived Chat', archived: true }),
    makeSession({ id: 'arch-2', title: 'Old Chat', archived: true }),
  ],
  activeSessionId: 'sess-1',
  activeView: 'chat' as const,
  generatingTitleId: null,
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('archives section', () => {
    it('renders archives section when there are archived sessions', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      expect(w.find('.sidebar-archives').exists()).toBe(true)
      w.unmount()
    })

    it('does not render archives section when there are no archived sessions', () => {
      const w = mount(SessionSidebar, {
        props: { ...defaultProps, archivedSessions: [] },
      })
      expect(w.find('.sidebar-archives').exists()).toBe(false)
      w.unmount()
    })

    it('shows archive count in header', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      const header = w.find('.sidebar-archives .sidebar-section-title')
      expect(header.text()).toContain('Archives (2)')
      w.unmount()
    })

    it('archives list is open by default', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      const collapsible = w.find('.archives-collapsible')
      expect(collapsible.classes()).toContain('open')
      w.unmount()
    })

    it('clicking header toggles the collapsible wrapper closed', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })

      await w.find('.sidebar-archives .sidebar-section-header').trigger('click')
      await nextTick()

      const collapsible = w.find('.archives-collapsible')
      expect(collapsible.classes()).not.toContain('open')
      w.unmount()
    })

    it('clicking header twice reopens the collapsible wrapper', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })

      await w.find('.sidebar-archives .sidebar-section-header').trigger('click')
      await w.find('.sidebar-archives .sidebar-section-header').trigger('click')
      await nextTick()

      const collapsible = w.find('.archives-collapsible')
      expect(collapsible.classes()).toContain('open')
      w.unmount()
    })

    it('archived session items are always in DOM (not removed on collapse)', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })

      // Collapse
      await w.find('.sidebar-archives .sidebar-section-header').trigger('click')
      await nextTick()

      // Items should still be in the DOM for animation purposes
      const items = w.findAll('.sidebar-archives .sidebar-list')
      expect(items.length).toBe(1)
      w.unmount()
    })

    it('chevron rotates when open', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      const chevron = w.find('.sidebar-archives .collapse-chevron')
      expect(chevron.classes()).toContain('open')
      w.unmount()
    })

    it('chevron is not rotated when closed', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })

      await w.find('.sidebar-archives .sidebar-section-header').trigger('click')
      await nextTick()

      const chevron = w.find('.sidebar-archives .collapse-chevron')
      expect(chevron.classes()).not.toContain('open')
      w.unmount()
    })

    it('persists open/close state to localStorage', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })

      await w.find('.sidebar-archives .sidebar-section-header').trigger('click')
      await nextTick()

      expect(localStorage.getItem('bond:archives-open')).toBe('false')
      w.unmount()
    })

    it('restores closed state from localStorage', () => {
      localStorage.setItem('bond:archives-open', 'false')
      const w = mount(SessionSidebar, { props: defaultProps })

      const collapsible = w.find('.archives-collapsible')
      expect(collapsible.classes()).not.toContain('open')
      w.unmount()
    })
  })
})
