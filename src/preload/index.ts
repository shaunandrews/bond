import { contextBridge, ipcRenderer } from 'electron'
import type { BondStreamChunk } from '../shared/stream'
import type { Session, SessionMessage } from '../shared/session'

contextBridge.exposeInMainWorld('bond', {
  send: (text: string) => ipcRenderer.invoke('bond:send', text) as Promise<{ ok: boolean; error?: string }>,
  cancel: () => ipcRenderer.invoke('bond:cancel') as Promise<{ ok: boolean }>,
  onChunk: (fn: (chunk: BondStreamChunk) => void) => {
    const listener = (_: Electron.IpcRendererEvent, chunk: BondStreamChunk) => fn(chunk)
    ipcRenderer.on('bond:chunk', listener)
    return () => ipcRenderer.removeListener('bond:chunk', listener)
  },

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
  generateTitle: (sessionId: string) =>
    ipcRenderer.invoke('session:generateTitle', sessionId) as Promise<{ title: string; summary: string }>
})
