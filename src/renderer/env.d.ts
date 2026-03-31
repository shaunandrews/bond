declare global {
  interface Window {
    bond: {
      send: (text: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>
      cancel: (sessionId?: string) => Promise<{ ok: boolean }>
      respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: import('../../shared/stream').TaggedChunk) => void) => () => void
      listSessions: () => Promise<import('../../shared/session').Session[]>
      createSession: (options?: { siteId?: string; title?: string }) => Promise<import('../../shared/session').Session>
      getSession: (id: string) => Promise<import('../../shared/session').Session | null>
      updateSession: (id: string, updates: Partial<Pick<import('../../shared/session').Session, 'title' | 'summary' | 'archived' | 'siteId'>>) => Promise<import('../../shared/session').Session | null>
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
      readLocalImage: (filePath: string) => Promise<string | null>
      getAccentColor: () => Promise<string>
      saveAccentColor: (hex: string) => Promise<boolean>
      listWordPressSites: () => Promise<{ available: boolean; sites: import('../../shared/wordpress').WordPressSite[] }>
      getWordPressSiteDetails: (path: string) => Promise<import('../../shared/wordpress').WordPressSiteDetails | null>
      getWordPressSiteMap: (path: string) => Promise<import('../../shared/wordpress').WpSiteMap | null>
      getWordPressThemeJson: (path: string) => Promise<import('../../shared/wordpress').WpThemeJson | null>
      createWordPressSite: (name: string) => Promise<{ available: boolean; sites: import('../../shared/wordpress').WordPressSite[] }>
      deleteWordPressSite: (path: string) => Promise<{ available: boolean; sites: import('../../shared/wordpress').WordPressSite[] }>
      startWordPressSite: (path: string) => Promise<{ available: boolean; sites: import('../../shared/wordpress').WordPressSite[] }>
      stopWordPressSite: (path: string) => Promise<{ available: boolean; sites: import('../../shared/wordpress').WordPressSite[] }>
    }
  }
}

export {}
