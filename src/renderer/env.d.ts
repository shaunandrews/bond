declare global {
  interface Window {
    bond: {
      send: (text: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>
      cancel: (sessionId?: string) => Promise<{ ok: boolean }>
      respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: import('../../shared/stream').TaggedChunk) => void) => () => void
      listSessions: () => Promise<import('../../shared/session').Session[]>
      createSession: () => Promise<import('../../shared/session').Session>
      getSession: (id: string) => Promise<import('../../shared/session').Session | null>
      updateSession: (id: string, updates: Partial<Pick<import('../../shared/session').Session, 'title' | 'summary' | 'archived'>>) => Promise<import('../../shared/session').Session | null>
      deleteSession: (id: string) => Promise<boolean>
      getMessages: (sessionId: string) => Promise<import('../../shared/session').SessionMessage[]>
      saveMessages: (sessionId: string, messages: import('../../shared/session').SessionMessage[]) => Promise<boolean>
      generateTitle: (sessionId: string) => Promise<{ title: string; summary: string }>
      listSkills: () => Promise<{ name: string; description: string; argumentHint: string }[]>
      refreshSkills: () => Promise<{ name: string; description: string; argumentHint: string }[]>
      removeSkill: (name: string) => Promise<{ ok: boolean }>
      openExternal: (url: string) => Promise<void>
      setModel: (model: string) => Promise<{ ok: boolean }>
      getModel: () => Promise<string>
      getSoul: () => Promise<string>
      saveSoul: (content: string) => Promise<boolean>
      getAccentColor: () => Promise<string>
      saveAccentColor: (hex: string) => Promise<boolean>
    }
  }
}

export {}
