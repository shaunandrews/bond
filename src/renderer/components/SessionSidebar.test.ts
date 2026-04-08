import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SessionSidebar from './SessionSidebar.vue'
import type { Session } from '../../shared/session'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'sess-1',
    title: overrides.title ?? 'Test Chat',
    summary: overrides.summary ?? '',
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
  generatingTitleId: null,
  busySessionIds: new Set<string>(),
}

async function openFlyout(w: ReturnType<typeof mount>) {
  // Archive button is the first button in the chats panel header actions
  const chatsPanel = w.find('[data-panel-id="chats"]')
  const archiveBtn = chatsPanel.find('.bond-panel__header-actions button')
  await archiveBtn.trigger('click')
  await nextTick()
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    // Clean up any teleported elements from previous tests
    document.body.querySelectorAll('.bond-flyout-menu').forEach((el) => el.remove())
  })

  describe('chats header', () => {
    it('renders Chats header without count', () => {
      const w = mount(SessionSidebar, { props: defaultProps })
      const chatsPanel = w.find('[data-panel-id="chats"]')
      expect(chatsPanel.find('.bond-panel__header-label').text()).toContain('Chats')
      expect(chatsPanel.find('.bond-panel__header-label').text()).not.toMatch(/\(\d+\)/)
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
      // New chat button is the last button in the chats panel header actions
      const chatsPanel = w.find('[data-panel-id="chats"]')
      const buttons = chatsPanel.findAll('.bond-panel__header-actions button')
      const newChatBtn = buttons[buttons.length - 1]
      expect(newChatBtn).toBeTruthy()
      await newChatBtn.trigger('click')
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
      const flyout = document.body.querySelector('.bond-flyout-menu')
      expect(flyout?.textContent).toContain('Archived (2)')
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
      const flyout = document.body.querySelector('.bond-flyout-menu')
      expect(flyout?.textContent).toContain('No archived chats')
      w.unmount()
    })
  })
})
