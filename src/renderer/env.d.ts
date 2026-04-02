declare global {
  interface Window {
    bond: {
      send: (text: string, sessionId?: string, images?: import('../../shared/session').AttachedImage[]) => Promise<{ ok: boolean; error?: string; imageIds?: string[] }>
      cancel: (sessionId?: string) => Promise<{ ok: boolean }>
      respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: import('../../shared/stream').TaggedChunk) => void) => () => void
      listSessions: () => Promise<import('../../shared/session').Session[]>
      createSession: (options?: { title?: string }) => Promise<import('../../shared/session').Session>
      getSession: (id: string) => Promise<import('../../shared/session').Session | null>
      updateSession: (id: string, updates: Partial<Pick<import('../../shared/session').Session, 'title' | 'summary' | 'archived' | 'editMode'>>) => Promise<import('../../shared/session').Session | null>
      deleteSession: (id: string) => Promise<boolean>
      deleteArchivedSessions: () => Promise<{ ok: boolean; count: number }>
      getMessages: (sessionId: string) => Promise<import('../../shared/session').SessionMessage[]>
      saveMessages: (sessionId: string, messages: import('../../shared/session').SessionMessage[]) => Promise<boolean>
      generateTitle: (sessionId: string) => Promise<{ title: string; summary: string }>
      listTodos: () => Promise<import('../../shared/session').TodoItem[]>
      createTodo: (text: string) => Promise<import('../../shared/session').TodoItem>
      updateTodo: (id: string, updates: Partial<Pick<import('../../shared/session').TodoItem, 'text' | 'done'>>) => Promise<import('../../shared/session').TodoItem | null>
      deleteTodo: (id: string) => Promise<boolean>
      listImages: () => Promise<import('../../shared/session').ImageRecord[]>
      getImage: (imageId: string) => Promise<import('../../shared/session').AttachedImage | null>
      getImages: (ids: string[]) => Promise<(import('../../shared/session').AttachedImage | null)[]>
      deleteImage: (imageId: string) => Promise<boolean>
      listSkills: () => Promise<{ name: string; description: string; argumentHint: string }[]>
      refreshSkills: () => Promise<{ name: string; description: string; argumentHint: string }[]>
      removeSkill: (name: string) => Promise<{ ok: boolean }>
      readLocalImage: (filePath: string) => Promise<string | null>
      captureScreenshot: (outputPath: string) => Promise<string>
      openExternal: (url: string) => Promise<void>
      openSettings: () => Promise<void>
      createSkillViaChat: (description: string) => Promise<void>
      onCreateSkill: (fn: (description: string) => void) => () => void
      setModel: (model: string) => Promise<{ ok: boolean }>
      getModel: () => Promise<string>
      onModelChanged: (fn: (model: string) => void) => () => void
      getSoul: () => Promise<string>
      saveSoul: (content: string) => Promise<boolean>
      getAccentColor: () => Promise<string>
      saveAccentColor: (hex: string) => Promise<boolean>
      onAccentColor: (fn: (hex: string) => void) => () => void
      getWindowOpacity: () => Promise<number>
      saveWindowOpacity: (opacity: number) => Promise<boolean>
      onWindowOpacity: (fn: (opacity: number) => void) => () => void
    }
  }
}

export {}
