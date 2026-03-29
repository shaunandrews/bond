declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

import type { BondStreamChunk } from '../shared/stream'
import type { Session, SessionMessage } from '../shared/session'

declare global {
  interface Window {
    bond: {
      send: (text: string) => Promise<{ ok: boolean; error?: string }>
      cancel: () => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: BondStreamChunk) => void) => () => void
      listSessions: () => Promise<Session[]>
      createSession: () => Promise<Session>
      getSession: (id: string) => Promise<Session | null>
      updateSession: (id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived'>>) => Promise<Session | null>
      deleteSession: (id: string) => Promise<boolean>
      getMessages: (sessionId: string) => Promise<SessionMessage[]>
      saveMessages: (sessionId: string, messages: SessionMessage[]) => Promise<boolean>
      generateTitle: (sessionId: string) => Promise<{ title: string; summary: string }>
      setModel: (model: string) => Promise<{ ok: boolean }>
      getModel: () => Promise<string>
    }
  }
}
