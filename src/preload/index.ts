import { contextBridge, ipcRenderer } from 'electron'
import type { TaggedChunk } from '../shared/stream'
import type { Session, SessionMessage, AttachedImage, ImageRecord, TodoItem, Project, ProjectResource, ProjectType } from '../shared/session'

contextBridge.exposeInMainWorld('bond', {
  send: (text: string, sessionId?: string, images?: AttachedImage[]) => ipcRenderer.invoke('bond:send', text, sessionId, images) as Promise<{ ok: boolean; error?: string; imageIds?: string[] }>,
  cancel: (sessionId?: string) => ipcRenderer.invoke('bond:cancel', sessionId) as Promise<{ ok: boolean }>,
  respondToApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke('bond:approvalResponse', requestId, approved) as Promise<{ ok: boolean }>,
  onChunk: (fn: (chunk: TaggedChunk) => void) => {
    const listener = (_: Electron.IpcRendererEvent, chunk: TaggedChunk) => fn(chunk)
    ipcRenderer.on('bond:chunk', listener)
    return () => ipcRenderer.removeListener('bond:chunk', listener)
  },

  // Model
  setModel: (model: string) => ipcRenderer.invoke('bond:setModel', model) as Promise<{ ok: boolean }>,
  getModel: () => ipcRenderer.invoke('bond:getModel') as Promise<string>,

  onModelChanged: (fn: (model: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, model: string) => fn(model)
    ipcRenderer.on('bond:modelChanged', listener)
    return () => ipcRenderer.removeListener('bond:modelChanged', listener)
  },

  // Sessions
  listSessions: () => ipcRenderer.invoke('session:list') as Promise<Session[]>,
  createSession: (options?: { title?: string; projectId?: string }) => ipcRenderer.invoke('session:create', options) as Promise<Session>,
  getSession: (id: string) => ipcRenderer.invoke('session:get', id) as Promise<Session | null>,
  updateSession: (id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived' | 'editMode' | 'projectId'>>) => ipcRenderer.invoke('session:update', id, updates) as Promise<Session | null>,
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id) as Promise<boolean>,
  deleteArchivedSessions: () => ipcRenderer.invoke('session:deleteArchived') as Promise<{ ok: boolean; count: number }>,
  getMessages: (sessionId: string) => ipcRenderer.invoke('session:getMessages', sessionId) as Promise<SessionMessage[]>,
  saveMessages: (sessionId: string, messages: SessionMessage[]) =>
    ipcRenderer.invoke('session:saveMessages', sessionId, messages) as Promise<boolean>,
  generateTitle: (sessionId: string, userMessage?: string) =>
    ipcRenderer.invoke('session:generateTitle', sessionId, userMessage) as Promise<{ title: string; summary: string }>,

  // Todos
  listTodos: () => ipcRenderer.invoke('todo:list') as Promise<TodoItem[]>,
  onTodoChanged: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:todoChanged', listener)
    return () => ipcRenderer.removeListener('bond:todoChanged', listener)
  },
  createTodo: (text: string, notes?: string, group?: string, projectId?: string) => ipcRenderer.invoke('todo:create', text, notes, group, projectId) as Promise<TodoItem>,
  updateTodo: (id: string, updates: Partial<Pick<TodoItem, 'text' | 'notes' | 'group' | 'done' | 'projectId'>>) => ipcRenderer.invoke('todo:update', id, updates) as Promise<TodoItem | null>,
  deleteTodo: (id: string) => ipcRenderer.invoke('todo:delete', id) as Promise<boolean>,
  parseTodo: (raw: string) => ipcRenderer.invoke('todo:parse', raw) as Promise<{ title: string; notes: string; group: string }>,
  reorderTodos: (ids: string[]) => ipcRenderer.invoke('todo:reorder', ids) as Promise<boolean>,

  // Projects
  listProjects: () => ipcRenderer.invoke('project:list') as Promise<Project[]>,
  getProject: (id: string) => ipcRenderer.invoke('project:get', id) as Promise<Project | null>,
  createProject: (name: string, goal?: string, type?: ProjectType, deadline?: string) => ipcRenderer.invoke('project:create', name, goal, type, deadline) as Promise<Project>,
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'goal' | 'type' | 'archived' | 'deadline'>>) => ipcRenderer.invoke('project:update', id, updates) as Promise<Project | null>,
  deleteProject: (id: string) => ipcRenderer.invoke('project:delete', id) as Promise<boolean>,
  addProjectResource: (projectId: string, kind: ProjectResource['kind'], value: string, label?: string) => ipcRenderer.invoke('project:addResource', projectId, kind, value, label) as Promise<ProjectResource>,
  removeProjectResource: (id: string) => ipcRenderer.invoke('project:removeResource', id) as Promise<boolean>,
  onProjectsChanged: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:projectsChanged', listener)
    return () => ipcRenderer.removeListener('bond:projectsChanged', listener)
  },

  // Images
  listImages: () => ipcRenderer.invoke('image:list') as Promise<ImageRecord[]>,
  getImage: (imageId: string) => ipcRenderer.invoke('image:get', imageId) as Promise<AttachedImage | null>,
  getImages: (ids: string[]) => ipcRenderer.invoke('image:getMultiple', ids) as Promise<(AttachedImage | null)[]>,
  deleteImage: (imageId: string) => ipcRenderer.invoke('image:delete', imageId) as Promise<boolean>,

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<{ name: string; description: string; argumentHint: string }[]>,
  refreshSkills: () => ipcRenderer.invoke('skills:refresh') as Promise<{ name: string; description: string; argumentHint: string }[]>,
  removeSkill: (name: string) => ipcRenderer.invoke('skills:remove', name) as Promise<{ ok: boolean }>,

  // Local images
  readLocalImage: (filePath: string) => ipcRenderer.invoke('image:readLocal', filePath) as Promise<string | null>,

  // File viewing
  openViewer: (filePath: string) => ipcRenderer.invoke('viewer:open', filePath) as Promise<void>,
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath) as Promise<string | null>,
  onViewerFile: (fn: (filePath: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, filePath: string) => fn(filePath)
    ipcRenderer.on('bond:viewerFile', listener)
    return () => ipcRenderer.removeListener('bond:viewerFile', listener)
  },

  // Dev
  captureScreenshot: (outputPath: string) => ipcRenderer.invoke('dev:captureScreenshot', outputPath) as Promise<string>,

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url) as Promise<void>,
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath) as Promise<string>,

  // Settings window
  openSettings: () => ipcRenderer.invoke('window:openSettings') as Promise<void>,
  createSkillViaChat: (description: string) => ipcRenderer.invoke('settings:createSkillViaChat', description) as Promise<void>,
  onCreateSkill: (fn: (description: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, description: string) => fn(description)
    ipcRenderer.on('bond:createSkill', listener)
    return () => ipcRenderer.removeListener('bond:createSkill', listener)
  },

  // Connection status
  onConnectionLost: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:connectionLost', listener)
    return () => ipcRenderer.removeListener('bond:connectionLost', listener)
  },
  onConnectionRestored: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('bond:connectionRestored', listener)
    return () => ipcRenderer.removeListener('bond:connectionRestored', listener)
  },

  // Settings
  getSoul: () => ipcRenderer.invoke('settings:getSoul') as Promise<string>,
  saveSoul: (content: string) => ipcRenderer.invoke('settings:saveSoul', content) as Promise<boolean>,
  getAccentColor: () => ipcRenderer.invoke('settings:getAccentColor') as Promise<string>,
  saveAccentColor: (hex: string) => ipcRenderer.invoke('settings:saveAccentColor', hex) as Promise<boolean>,
  onAccentColor: (fn: (hex: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, hex: string) => fn(hex)
    ipcRenderer.on('bond:accentColor', listener)
    return () => ipcRenderer.removeListener('bond:accentColor', listener)
  },
  getWindowOpacity: () => ipcRenderer.invoke('settings:getWindowOpacity') as Promise<number>,
  saveWindowOpacity: (opacity: number) => ipcRenderer.invoke('settings:saveWindowOpacity', opacity) as Promise<boolean>,
  onWindowOpacity: (fn: (opacity: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, opacity: number) => fn(opacity)
    ipcRenderer.on('bond:windowOpacity', listener)
    return () => ipcRenderer.removeListener('bond:windowOpacity', listener)
  },

})
