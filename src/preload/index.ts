import { contextBridge, ipcRenderer } from 'electron'
import type { TaggedChunk } from '../shared/stream'
import type { Session, SessionMessage } from '../shared/session'

contextBridge.exposeInMainWorld('bond', {
  send: (text: string, sessionId?: string) => ipcRenderer.invoke('bond:send', text, sessionId) as Promise<{ ok: boolean; error?: string }>,
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

  // Sessions
  listSessions: () => ipcRenderer.invoke('session:list') as Promise<Session[]>,
  createSession: () => ipcRenderer.invoke('session:create') as Promise<Session>,
  getSession: (id: string) => ipcRenderer.invoke('session:get', id) as Promise<Session | null>,
  updateSession: (id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived'>>) =>
    ipcRenderer.invoke('session:update', id, updates) as Promise<Session | null>,
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id) as Promise<boolean>,
  getMessages: (sessionId: string) => ipcRenderer.invoke('session:getMessages', sessionId) as Promise<SessionMessage[]>,
  saveMessages: (sessionId: string, messages: SessionMessage[]) =>
    ipcRenderer.invoke('session:saveMessages', sessionId, messages) as Promise<boolean>,
  generateTitle: (sessionId: string, userMessage?: string) =>
    ipcRenderer.invoke('session:generateTitle', sessionId, userMessage) as Promise<{ title: string; summary: string }>,

  // Settings
  getSoul: () => ipcRenderer.invoke('settings:getSoul') as Promise<string>,
  saveSoul: (content: string) => ipcRenderer.invoke('settings:saveSoul', content) as Promise<boolean>
})
