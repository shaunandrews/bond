export interface BrowserTab {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  hidden: boolean
}

export type BrowserCommand =
  | { type: 'open'; requestId: string; url: string; hidden?: boolean }
  | { type: 'navigate'; requestId: string; tabId: string; url: string }
  | { type: 'close'; requestId: string; tabId: string }
  | { type: 'tabs'; requestId: string }
  | { type: 'read'; requestId: string; tabId?: string }
  | { type: 'screenshot'; requestId: string; tabId?: string }
  | { type: 'exec'; requestId: string; tabId?: string; js: string }
  | { type: 'console'; requestId: string; tabId?: string }
  | { type: 'dom'; requestId: string; tabId?: string; selector?: string }
  | { type: 'network'; requestId: string; tabId?: string }
  | { type: 'download'; requestId: string; tabId?: string; url: string }
  | { type: 'cookies'; requestId: string; tabId?: string }

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  text: string
  args: string[]
  timestamp: number
  source?: string
  stackTrace?: string
}

export interface NetworkEntry {
  requestId: string
  url: string
  method: string
  status: number | null
  mimeType: string | null
  size: number | null
  timing: number
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string> | null
}

export const MAX_TABS = 8
export const MAX_HIDDEN_TABS = 5
export const DEFAULT_URL = 'about:blank'
