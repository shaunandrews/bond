import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { useSessions, type SessionDeps } from './useSessions'
import type { Session } from '../../shared/session'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    title: 'Test chat',
    summary: '',
    archived: false,
    editMode: { type: 'full' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function mockDeps(): SessionDeps {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockImplementation(async () => makeSession({ title: 'New chat' })),
    updateSession: vi.fn().mockImplementation(async (_id: string, updates: Partial<Session>) => {
      return { ...makeSession(), ...updates }
    }),
    deleteSession: vi.fn().mockResolvedValue(true),
    deleteArchivedSessions: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    generateTitle: vi.fn().mockResolvedValue({ title: 'Generated', summary: 'A summary' }),
  }
}

type UseSessionsReturn = ReturnType<typeof useSessions>

function withSetup(deps: SessionDeps): UseSessionsReturn {
  let result!: UseSessionsReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useSessions(deps)
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useSessions', () => {
  let deps: SessionDeps
  let s: UseSessionsReturn

  beforeEach(() => {
    localStorage.clear()
    deps = mockDeps()
    s = withSetup(deps)
  })

  it('load fetches sessions from deps', async () => {
    const sessions = [makeSession({ title: 'A' }), makeSession({ title: 'B' })]
    ;(deps.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions)

    await s.load()

    expect(s.sessions.value).toHaveLength(2)
  })

  it('create adds a session and selects it', async () => {
    const session = await s.create()

    expect(s.sessions.value).toHaveLength(1)
    expect(s.activeSessionId.value).toBe(session.id)
  })

  it('select sets activeSessionId', () => {
    s.select('abc')
    expect(s.activeSessionId.value).toBe('abc')
  })

  it('archive marks session as archived', async () => {
    const session = makeSession()
    s.sessions.value = [session]
    s.activeSessionId.value = session.id

    ;(deps.updateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...session,
      archived: true,
    })

    await s.archive(session.id)

    expect(s.sessions.value[0].archived).toBe(true)
    // Active session should switch away
    expect(s.activeSessionId.value).toBeNull()
  })

  it('unarchive marks session as not archived', async () => {
    const session = makeSession({ archived: true })
    s.sessions.value = [session]

    ;(deps.updateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...session,
      archived: false,
    })

    await s.unarchive(session.id)

    expect(s.sessions.value[0].archived).toBe(false)
  })

  it('remove deletes session from list', async () => {
    const session = makeSession()
    s.sessions.value = [session]
    s.activeSessionId.value = session.id

    await s.remove(session.id)

    expect(s.sessions.value).toHaveLength(0)
    expect(s.activeSessionId.value).toBeNull()
  })

  it('activeSessions filters out archived', () => {
    s.sessions.value = [
      makeSession({ id: '1', archived: false }),
      makeSession({ id: '2', archived: true }),
    ]

    expect(s.activeSessions.value).toHaveLength(1)
    expect(s.activeSessions.value[0].id).toBe('1')
  })

  it('archivedSessions filters to archived', () => {
    s.sessions.value = [
      makeSession({ id: '1', archived: false }),
      makeSession({ id: '2', archived: true }),
    ]

    expect(s.archivedSessions.value).toHaveLength(1)
    expect(s.archivedSessions.value[0].id).toBe('2')
  })

  it('refreshTitle updates session title', async () => {
    const session = makeSession({ title: 'New chat' })
    s.sessions.value = [session]

    await s.refreshTitle(session.id)

    expect(deps.generateTitle).toHaveBeenCalledWith(session.id)
    expect(s.sessions.value[0].title).toBe('Generated')
    expect(s.sessions.value[0].summary).toBe('A summary')
  })
})
