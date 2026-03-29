import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import type { Session, SessionMessage } from '../shared/session'

const sessionsDir = () => join(app.getPath('userData'), 'sessions')

function ensureDir(): void {
  const dir = sessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

interface SessionFile {
  session: Session
  messages: SessionMessage[]
}

function readSessionFile(id: string): SessionFile | null {
  const p = sessionPath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionFile
  } catch {
    return null
  }
}

function writeSessionFile(data: SessionFile): void {
  ensureDir()
  writeFileSync(sessionPath(data.session.id), JSON.stringify(data, null, 2), 'utf-8')
}

// --- Public API ---

export function listSessions(): Session[] {
  ensureDir()
  const files = readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'))
  const sessions: Session[] = []
  for (const file of files) {
    const id = file.replace('.json', '')
    const data = readSessionFile(id)
    if (data) sessions.push(data.session)
  }
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return sessions
}

export function createSession(): Session {
  const now = new Date().toISOString()
  const session: Session = {
    id: crypto.randomUUID(),
    title: 'New chat',
    summary: '',
    archived: false,
    createdAt: now,
    updatedAt: now
  }
  writeSessionFile({ session, messages: [] })
  return session
}

export function getSession(id: string): Session | null {
  return readSessionFile(id)?.session ?? null
}

export function updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'summary' | 'archived'>>): Session | null {
  const data = readSessionFile(id)
  if (!data) return null
  Object.assign(data.session, updates, { updatedAt: new Date().toISOString() })
  writeSessionFile(data)
  return data.session
}

export function deleteSession(id: string): boolean {
  const p = sessionPath(id)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}

export function getMessages(sessionId: string): SessionMessage[] {
  return readSessionFile(sessionId)?.messages ?? []
}

export function saveMessages(sessionId: string, messages: SessionMessage[]): boolean {
  const data = readSessionFile(sessionId)
  if (!data) return false
  data.messages = messages
  data.session.updatedAt = new Date().toISOString()
  writeSessionFile(data)
  return true
}
