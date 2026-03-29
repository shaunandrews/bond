import { ref, computed } from 'vue'
import type { Session } from '../../shared/session'

export interface SessionDeps {
  listSessions: () => Promise<Session[]>
  createSession: () => Promise<Session>
  updateSession: (id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived'>>) => Promise<Session | null>
  deleteSession: (id: string) => Promise<boolean>
  generateTitle: (sessionId: string) => Promise<{ title: string; summary: string }>
}

export function useSessions(deps: SessionDeps = window.bond) {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const showArchived = ref(false)

  const activeSessions = computed(() =>
    sessions.value.filter((s) => !s.archived)
  )

  const archivedSessions = computed(() =>
    sessions.value.filter((s) => s.archived)
  )

  const activeSession = computed(() =>
    sessions.value.find((s) => s.id === activeSessionId.value) ?? null
  )

  async function load() {
    sessions.value = await deps.listSessions()
  }

  async function create(): Promise<Session> {
    const session = await deps.createSession()
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    return session
  }

  function select(id: string) {
    activeSessionId.value = id
  }

  async function archive(id: string) {
    const updated = await deps.updateSession(id, { archived: true })
    if (updated) {
      const idx = sessions.value.findIndex((s) => s.id === id)
      if (idx !== -1) sessions.value[idx] = updated
      if (activeSessionId.value === id) {
        const next = activeSessions.value[0]
        activeSessionId.value = next?.id ?? null
      }
    }
  }

  async function unarchive(id: string) {
    const updated = await deps.updateSession(id, { archived: false })
    if (updated) {
      const idx = sessions.value.findIndex((s) => s.id === id)
      if (idx !== -1) sessions.value[idx] = updated
    }
  }

  async function remove(id: string) {
    const ok = await deps.deleteSession(id)
    if (ok) {
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeSessionId.value === id) {
        const next = activeSessions.value[0]
        activeSessionId.value = next?.id ?? null
      }
    }
  }

  async function refreshTitle(id: string) {
    const { title, summary } = await deps.generateTitle(id)
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx !== -1) {
      sessions.value[idx] = { ...sessions.value[idx], title, summary }
    }
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    activeSessions,
    archivedSessions,
    showArchived,
    load,
    create,
    select,
    archive,
    unarchive,
    remove,
    refreshTitle
  }
}
