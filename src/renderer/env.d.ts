declare global {
  interface Window {
    bond: {
      send: (text: string, sessionId?: string, images?: import('../../shared/session').AttachedImage[]) => Promise<{ ok: boolean; error?: string; imageIds?: string[] }>
      cancel: (sessionId?: string) => Promise<{ ok: boolean }>
      respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: import('../../shared/stream').TaggedChunk) => void) => () => void
      listSessions: () => Promise<import('../../shared/session').Session[]>
      createSession: (options?: { title?: string; projectId?: string }) => Promise<import('../../shared/session').Session>
      getSession: (id: string) => Promise<import('../../shared/session').Session | null>
      updateSession: (id: string, updates: Partial<Pick<import('../../shared/session').Session, 'title' | 'summary' | 'archived' | 'editMode' | 'projectId'>>) => Promise<import('../../shared/session').Session | null>
      deleteSession: (id: string) => Promise<boolean>
      deleteArchivedSessions: () => Promise<{ ok: boolean; count: number }>
      getMessages: (sessionId: string) => Promise<import('../../shared/session').SessionMessage[]>
      saveMessages: (sessionId: string, messages: import('../../shared/session').SessionMessage[]) => Promise<boolean>
      generateTitle: (sessionId: string) => Promise<{ title: string; summary: string }>
      onTodoChanged: (fn: () => void) => () => void
      listTodos: () => Promise<import('../../shared/session').TodoItem[]>
      createTodo: (text: string, notes?: string, group?: string, projectId?: string) => Promise<import('../../shared/session').TodoItem>
      updateTodo: (id: string, updates: Partial<Pick<import('../../shared/session').TodoItem, 'text' | 'notes' | 'group' | 'done' | 'projectId'>>) => Promise<import('../../shared/session').TodoItem | null>
      deleteTodo: (id: string) => Promise<boolean>
      parseTodo: (raw: string) => Promise<{ title: string; notes: string; group: string }>
      reorderTodos: (ids: string[]) => Promise<boolean>
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
      openPath: (filePath: string) => Promise<string>
      openViewer: (filePath: string) => Promise<void>
      readFile: (filePath: string) => Promise<string | null>
      onViewerFile: (fn: (filePath: string) => void) => () => void
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
      // Projects
      listProjects: () => Promise<import('../../shared/session').Project[]>
      getProject: (id: string) => Promise<import('../../shared/session').Project | null>
      createProject: (name: string, goal?: string, type?: import('../../shared/session').ProjectType, deadline?: string) => Promise<import('../../shared/session').Project>
      updateProject: (id: string, updates: Partial<Pick<import('../../shared/session').Project, 'name' | 'goal' | 'type' | 'archived' | 'deadline'>>) => Promise<import('../../shared/session').Project | null>
      deleteProject: (id: string) => Promise<boolean>
      addProjectResource: (projectId: string, kind: import('../../shared/session').ProjectResource['kind'], value: string, label?: string) => Promise<import('../../shared/session').ProjectResource>
      removeProjectResource: (id: string) => Promise<boolean>
      onProjectsChanged: (fn: () => void) => () => void
      // Collections
      listCollections: () => Promise<import('../../shared/session').Collection[]>
      getCollection: (id: string) => Promise<import('../../shared/session').Collection | null>
      createCollection: (name: string, schema: import('../../shared/session').FieldDef[], icon?: string) => Promise<import('../../shared/session').Collection>
      updateCollection: (id: string, updates: Partial<Pick<import('../../shared/session').Collection, 'name' | 'icon' | 'schema' | 'archived'>>) => Promise<import('../../shared/session').Collection | null>
      deleteCollection: (id: string) => Promise<boolean>
      renameCollectionField: (id: string, oldName: string, newName: string) => Promise<boolean>
      listCollectionItems: (collectionId: string) => Promise<import('../../shared/session').CollectionItem[]>
      getCollectionItem: (id: string) => Promise<import('../../shared/session').CollectionItem | null>
      addCollectionItem: (collectionId: string, data: Record<string, unknown>) => Promise<import('../../shared/session').CollectionItem>
      updateCollectionItem: (id: string, data: Record<string, unknown>) => Promise<import('../../shared/session').CollectionItem | null>
      deleteCollectionItem: (id: string) => Promise<boolean>
      reorderCollectionItems: (ids: string[]) => Promise<boolean>
      onCollectionsChanged: (fn: () => void) => () => void
      // Browser
      browser: {
        onCommand: (fn: (cmd: import('../../shared/browser').BrowserCommand) => void) => () => void
        commandResult: (requestId: string, result: unknown) => Promise<void>
        registerWebContents: (tabId: string, webContentsId: number) => Promise<void>
        unregisterWebContents: (tabId: string) => Promise<void>
        captureTab: (tabId: string) => Promise<string>
        execInTab: (tabId: string, js: string) => Promise<unknown>
      }
      // Sense
      senseStatus: () => Promise<unknown>
      senseEnable: () => Promise<unknown>
      senseDisable: () => Promise<unknown>
      sensePause: (minutes?: number) => Promise<unknown>
      senseResume: () => Promise<unknown>
      senseNow: () => Promise<unknown>
      senseToday: () => Promise<unknown>
      senseSearch: (query: string, limit?: number) => Promise<import('../../shared/sense').SenseCapture[]>
      senseApps: (range?: string) => Promise<unknown>
      senseTimeline: (from?: string, to?: string, limit?: number) => Promise<import('../../shared/sense').SenseCapture[]>
      senseCapture: (id: string) => Promise<{ capture: import('../../shared/sense').SenseCapture; image: string | null }>
      senseSessions: (from?: string, to?: string) => Promise<import('../../shared/sense').SenseSession[]>
      senseSettings: () => Promise<import('../../shared/sense').SenseSettings>
      senseUpdateSettings: (updates: Record<string, unknown>) => Promise<unknown>
      senseClear: (range?: { from?: string; to?: string }) => Promise<unknown>
      senseStats: () => Promise<unknown>
      hasScreenRecordingPermission: () => Promise<boolean>
      // Operatives
      listOperatives: (filters?: { status?: string; sessionId?: string }) => Promise<import('../../shared/operative').Operative[]>
      getOperative: (id: string) => Promise<import('../../shared/operative').Operative | null>
      spawnOperative: (opts: import('../../shared/operative').SpawnOperativeOptions) => Promise<import('../../shared/operative').Operative>
      getOperativeEvents: (id: string, afterId?: number, limit?: number) => Promise<import('../../shared/operative').OperativeEvent[]>
      cancelOperative: (id: string) => Promise<{ ok: boolean }>
      removeOperative: (id: string) => Promise<{ ok: boolean }>
      clearOperatives: (status?: string) => Promise<{ deleted: number }>
      onOperativeChanged: (fn: () => void) => () => void
      onOperativeEvent: (fn: (payload: { operativeId: string; event: import('../../shared/operative').OperativeEvent }) => void) => () => void
      // Connection status
      onConnectionLost: (fn: () => void) => () => void
      onConnectionRestored: (fn: () => void) => () => void
    }
  }
}

export {}
