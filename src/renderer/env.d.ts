declare global {
  interface Window {
    bond: {
      send: {
        (input: import('../../shared/stream').BondSendInput): Promise<import('../../shared/rpc-schema').BondSendResult>
        (text: string, sessionId?: string, images?: import('../../shared/session').AttachedImage[]): Promise<import('../../shared/rpc-schema').BondSendResult>
      }
      cancel: (sessionId?: string) => Promise<{ ok: boolean }>
      respondToApproval: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>
      subscribe: (sessionId?: string) => Promise<{ ok: boolean }>
      unsubscribe: (sessionId?: string) => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: import('../../shared/stream').TaggedChunk) => void) => () => void
      listTranscript: (options?: { beforeSeq?: number; limit?: number }) => Promise<import('../../shared/transcript').TranscriptPage>
      upsertTranscript: (messages: import('../../shared/transcript').TranscriptMessage[]) => Promise<{ ok: boolean }>
      searchTranscript: (query: string, limit?: number) => Promise<{ messages: import('../../shared/transcript').TranscriptMessage[] }>
      createSession: (options?: { title?: string }) => Promise<import('../../shared/session').Session>
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
      getEditMode: () => Promise<import('../../shared/session').EditMode>
      setEditMode: (editMode: import('../../shared/session').EditMode) => Promise<{ ok: boolean }>
      getPiStatus: () => Promise<{ configured: boolean; providers: Array<{ providerId: string; type: 'api_key' | 'oauth' }> }>
      startPiOAuth: (provider: 'anthropic' | 'openai-codex') => Promise<{ url: string; instructions?: string; deviceCode?: string }>
      remoteStatus: () => Promise<{ running: boolean; port: number | null; token: string | null; urls: string[] }>
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
      // Onboarding + new-user sandbox
      onboardingStatus: () => Promise<import('../../shared/onboarding').OnboardingFirstRunState>
      onboardingBegin: () => Promise<import('../../shared/onboarding').OnboardingFirstRunState>
      onboardingSkip: () => Promise<import('../../shared/onboarding').OnboardingFirstRunState>
      sandboxStatus: () => Promise<import('../../shared/onboarding').SandboxStatus>
      // Memory
      memoryCore: () => Promise<import('../../shared/memory').CoreMemory>
      memoryUpdateCore: (core: import('../../shared/memory').CoreMemory) => Promise<import('../../shared/memory').CoreMemory>
      memoryWorking: () => Promise<import('../../shared/memory').WorkingState>
      memoryUpdateWorking: (working: import('../../shared/memory').WorkingState) => Promise<import('../../shared/memory').WorkingState>
      memoryClearWorking: () => Promise<import('../../shared/memory').WorkingState>
      memorySearch: (query: string, limit?: number) => Promise<{ results: import('../../shared/memory').RetrievedMemory[] }>
      memoryUpsert: (item: import('../../shared/memory').MemoryItemInput) => Promise<import('../../shared/memory').MemoryItem>
      memoryDelete: (id: string) => Promise<{ ok: boolean }>
      memorySources: (id: string) => Promise<import('../../shared/memory').MemorySourcesResult>
      senseMemory: (limit?: number) => Promise<{ debriefs: import('../../shared/sense').SessionDebrief[] }>
      senseDebrief: (id?: string, sessionId?: string) => Promise<import('../../shared/sense').SessionDebrief | null>
      senseDeleteDebrief: (id: string) => Promise<{ ok: boolean }>
      senseSystemPromptPreview: (editMode?: import('../../shared/session').EditMode) => Promise<{ prompt: string }>
      // Quick Chat
      onQuickChatInit: (fn: (data: { senseApps: string[] }) => void) => () => void
      onQuickChatDismiss: (fn: () => void) => () => void
      quickChatDismissed: () => Promise<void>
      // Connection status
      onConnectionLost: (fn: () => void) => () => void
      onConnectionRestored: (fn: () => void) => () => void
    }
  }
}

export {}
