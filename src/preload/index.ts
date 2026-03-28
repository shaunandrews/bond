import { contextBridge, ipcRenderer } from 'electron'
import type { BondStreamChunk } from '../shared/stream'

contextBridge.exposeInMainWorld('bond', {
  send: (text: string) => ipcRenderer.invoke('bond:send', text) as Promise<{ ok: boolean; error?: string }>,
  cancel: () => ipcRenderer.invoke('bond:cancel') as Promise<{ ok: boolean }>,
  onChunk: (fn: (chunk: BondStreamChunk) => void) => {
    const listener = (_: Electron.IpcRendererEvent, chunk: BondStreamChunk) => fn(chunk)
    ipcRenderer.on('bond:chunk', listener)
    return () => ipcRenderer.removeListener('bond:chunk', listener)
  }
})
