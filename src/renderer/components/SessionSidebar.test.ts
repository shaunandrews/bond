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

async function openFlyout(w: ReturnType<typeof mount>) {
  const archiveBtn = w.findAll('.chats-header-actions button').find(
    (b) => b.attributes('title') === 'Archived chats'
  )
  await archiveBtn!.trigger('click')
  await nextTick()
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    // Clean up any teleported elements from previous tests
    document.body.querySelectorAll('.bond-flyout-menu').forEach((el) => el.remove())
  })

  describe('chats header', () => {
    it('renders chat count in header', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      expect(w.find('.sidebar-section-title').text()).toContain('Chats (1)')
      w.unmount()
    })

    it('chats list is always visible (no collapsible wrapper)', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      expect(w.find('.chats-collapsible').exists()).toBe(false)
      expect(w.find('.chats-list').exists()).toBe(true)
      w.unmount()
    })

    it('no standalone archives section exists', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      expect(w.find('.sidebar-archives').exists()).toBe(false)
      w.unmount()
    })

    it('new chat button emits create', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      const newChatBtn = w.findAll('.chats-header-actions button').find(
        (b) => b.attributes('title') === 'New chat'
      )
      expect(newChatBtn).toBeTruthy()
      await newChatBtn!.trigger('click')
      expect(w.emitted('create')).toBeTruthy()
      w.unmount()
    })
  })

  describe('archive flyout', () => {
    it('flyout is closed by default', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      expect(document.body.querySelector('.bond-flyout-menu')).toBeNull()
      w.unmount()
    })

    it('clicking archive button opens flyout', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      await openFlyout(w)
      expect(document.body.querySelector('.bond-flyout-menu')).not.toBeNull()
      w.unmount()
    })

    it('flyout shows archived session count', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      await openFlyout(w)
      const header = document.body.querySelector('.archive-flyout-header')
      expect(header?.textContent).toContain('Archived (2)')
      w.unmount()
    })

    it('flyout renders archived sessions', async () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      await openFlyout(w)
      expect(document.body.querySelector('.archive-flyout-list')).not.toBeNull()
      w.unmount()
    })

    it('flyout shows empty state when no archives', async () => {
      const w = mount(SessionSidebar, {
        props: { ...defaultProps, archivedSessions: [] },
      })
      await openFlyout(w)
      const empty = document.body.querySelector('.archive-flyout-empty')
      expect(empty?.textContent).toBe('No archived chats')
      w.unmount()
    })
  })
})
