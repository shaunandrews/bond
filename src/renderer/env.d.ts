declare global {
  interface Window {
    bond: {
      send: (text: string, sessionId?: string, images?: import('../../shared/session').AttachedImage[]) => Promise<{ ok: boolean; error?: string; imageIds?: string[] }>
      cancel: (sessionId?: string) => Promise<{ ok: boolean }>
      respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
      subscribe: (sessionId: string) => Promise<{ ok: boolean }>
      unsubscribe: (sessionId: string) => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: import('../../shared/stream').TaggedChunk) => void) => () => void
      listSessions: () => Promise<import('../../shared/session').Session[]>
      createSession: (options?: { title?: string; projectId?: string }) => Promise<import('../../shared/session').Session>
      getSession: (id: string) => Promise<import('../../shared/session').Session | null>
      updateSession: (id: string, updates: Partial<Pick<import('../../shared/session').Session, 'title' | 'summary' | 'archived' | 'favorited' | 'quick' | 'iconSeed' | 'editMode' | 'projectId'>>) => Promise<import('../../shared/session').Session | null>
      deleteSession: (id: string) => Promise<boolean>
      deleteArchivedSessions: () => Promise<{ ok: boolean; count: number }>
      getMessages: (sessionId: string) => Promise<import('../../shared/session').SessionMessage[]>
      saveMessages: (sessionId: string, messages: import('../../shared/session').SessionMessage[]) => Promise<boolean>
      generateTitle: (sessionId: string) => Promise<{ title: string; summary: string }>
      listImages: () => Promise<import('../../shared/session').ImageRecord[]>
      getImage: (imageId: string) => Promise<import('../../shared/session').AttachedImage | null>
      getImages: (ids: string[]) => Promise<(import('../../shared/session').AttachedImage | null)[]>
      importImage: (data: string, mediaType: string) => Promise<import('../../shared/session').ImageRecord>
      deleteImage: (imageId: string) => Promise<boolean>
      onImageChanged: (fn: () => void) => () => void
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
      addItemComment: (itemId: string, author: 'user' | 'bond', body: string) => Promise<import('../../shared/session').ItemComment>
      deleteItemComment: (id: string) => Promise<boolean>
      onCollectionsChanged: (fn: () => void) => () => void
      // Journal (backed by Journal collection)
      listJournalEntries: (opts?: { author?: string; projectId?: string; tag?: string; limit?: number; offset?: number }) => Promise<import('../../shared/session').CollectionItem[]>
      getJournalEntry: (id: string) => Promise<import('../../shared/session').CollectionItem | null>
      createJournalEntry: (params: { author: 'user' | 'bond'; title: string; body: string; tags?: string[]; projectId?: string; sessionId?: string }) => Promise<import('../../shared/session').CollectionItem>
      updateJournalEntry: (id: string, updates: Record<string, unknown>) => Promise<import('../../shared/session').CollectionItem | null>
      deleteJournalEntry: (id: string) => Promise<boolean>
      searchJournalEntries: (query: string) => Promise<import('../../shared/session').CollectionItem[]>
      generateJournalMeta: (id: string) => Promise<import('../../shared/session').CollectionItem | null>
      addJournalComment: (entryId: string, author: 'user' | 'bond', body: string) => Promise<import('../../shared/session').ItemComment>
      deleteJournalComment: (id: string) => Promise<boolean>
      generateBondComment: (entryId: string) => Promise<import('../../shared/session').ItemComment>
      onJournalChanged: (fn: () => void) => () => void
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
      // Sense Debriefs
      senseMemory: (limit?: number) => Promise<{ debriefs: import('../../shared/sense').SessionDebrief[] }>
      senseDebrief: (id?: string, sessionId?: string) => Promise<import('../../shared/sense').SessionDebrief | null>
      senseDeleteDebrief: (id: string) => Promise<{ ok: boolean }>
      senseSystemPromptPreview: (projectId?: string) => Promise<{ prompt: string }>
      // Connection status
      onConnectionLost: (fn: () => void) => () => void
      onConnectionRestored: (fn: () => void) => () => void
    }
  }
}

export {}
