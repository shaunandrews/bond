import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import {
  listSessions, createSession, getSession, updateSession, deleteSession,
  deleteArchivedSessions, getMessages, saveMessages,
  savePendingApproval, removePendingApproval, clearSessionPendingApprovals, getPendingApprovals,
} from './sessions'

// Mock deleteSessionImages since it touches the filesystem
vi.mock('./images', () => ({
  deleteSessionImages: vi.fn(),
}))

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-sessions-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('sessions module', () => {
  describe('listSessions', () => {
    it('returns empty array initially', () => {
      expect(listSessions()).toEqual([])
    })

    it('returns all created sessions', () => {
      createSession({ title: 'Alpha' })
      createSession({ title: 'Beta' })
      const sessions = listSessions()
      expect(sessions).toHaveLength(2)
      const titles = sessions.map(s => s.title)
      expect(titles).toContain('Alpha')
      expect(titles).toContain('Beta')
    })
  })

  describe('createSession', () => {
    it('creates with default title', () => {
      const s = createSession()
      expect(s.id).toBeTruthy()
      expect(s.title).toBe('New chat')
      expect(s.summary).toBe('')
      expect(s.archived).toBe(false)
      expect(s.favorited).toBe(false)
      expect(s.editMode).toEqual({ type: 'full' })
    })

    it('creates with custom title', () => {
      const s = createSession({ title: 'My chat' })
      expect(s.title).toBe('My chat')
    })

    it('creates with project ID', () => {
      // Create a project first
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'Proj', '', 'generic', now, now)

      const s = createSession({ projectId: 'p1' })
      expect(s.projectId).toBe('p1')
    })
  })

  describe('getSession', () => {
    it('returns session by id', () => {
      const created = createSession({ title: 'Test' })
      const fetched = getSession(created.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.title).toBe('Test')
    })

    it('returns null for nonexistent id', () => {
      expect(getSession('fake')).toBeNull()
    })
  })

  describe('updateSession', () => {
    it('updates title', () => {
      const s = createSession()
      const updated = updateSession(s.id, { title: 'Updated' })
      expect(updated?.title).toBe('Updated')
    })

    it('updates archived', () => {
      const s = createSession()
      const updated = updateSession(s.id, { archived: true })
      expect(updated?.archived).toBe(true)
    })

    it('updates favorited', () => {
      const s = createSession()
      const updated = updateSession(s.id, { favorited: true })
      expect(updated?.favorited).toBe(true)
    })

    it('updates editMode', () => {
      const s = createSession()
      const updated = updateSession(s.id, { editMode: { type: 'readonly' } })
      expect(updated?.editMode).toEqual({ type: 'readonly' })
    })

    it('updates editMode to scoped', () => {
      const s = createSession()
      const updated = updateSession(s.id, { editMode: { type: 'scoped', allowedPaths: ['/src'] } })
      expect(updated?.editMode).toEqual({ type: 'scoped', allowedPaths: ['/src'] })
    })

    it('returns null for nonexistent id', () => {
      expect(updateSession('fake', { title: 'x' })).toBeNull()
    })
  })

  describe('deleteSession', () => {
    it('deletes existing session', () => {
      const s = createSession()
      expect(deleteSession(s.id)).toBe(true)
      expect(getSession(s.id)).toBeNull()
    })

    it('returns false for nonexistent id', () => {
      expect(deleteSession('fake')).toBe(false)
    })
  })

  describe('deleteArchivedSessions', () => {
    it('deletes only archived sessions', () => {
      const s1 = createSession({ title: 'Active' })
      const s2 = createSession({ title: 'Archived' })
      updateSession(s2.id, { archived: true })

      const count = deleteArchivedSessions()
      expect(count).toBe(1)
      expect(getSession(s1.id)).not.toBeNull()
      expect(getSession(s2.id)).toBeNull()
    })

    it('returns 0 when no archived sessions', () => {
      createSession()
      expect(deleteArchivedSessions()).toBe(0)
    })
  })

  describe('messages', () => {
    it('returns empty array for session with no messages', () => {
      const s = createSession()
      expect(getMessages(s.id)).toEqual([])
    })

    it('saves and retrieves messages', () => {
      const s = createSession()
      const msgs = [
        { id: 'msg-1', role: 'user', text: 'Hello' },
        { id: 'msg-2', role: 'bond', text: 'Hi there', streaming: false },
      ]
      expect(saveMessages(s.id, msgs)).toBe(true)

      const result = getMessages(s.id)
      expect(result).toHaveLength(2)
      expect(result[0].text).toBe('Hello')
      expect(result[1].text).toBe('Hi there')
    })

    it('preserves message ordering', () => {
      const s = createSession()
      saveMessages(s.id, [
        { id: 'a', role: 'user', text: 'First' },
        { id: 'b', role: 'bond', text: 'Second' },
        { id: 'c', role: 'user', text: 'Third' },
      ])
      const msgs = getMessages(s.id)
      expect(msgs.map(m => m.text)).toEqual(['First', 'Second', 'Third'])
    })

    it('handles messages with image IDs', () => {
      const s = createSession()
      saveMessages(s.id, [
        { id: 'msg-1', role: 'user', text: 'With image', imageIds: ['img-1', 'img-2'] },
      ])
      const msgs = getMessages(s.id)
      expect(msgs[0].imageIds).toEqual(['img-1', 'img-2'])
    })

    it('handles messages with kind/name/summary/status', () => {
      const s = createSession()
      saveMessages(s.id, [
        { id: 'msg-1', role: 'meta', kind: 'tool', name: 'bash', summary: 'ran ls' },
      ])
      const msgs = getMessages(s.id)
      expect(msgs[0].kind).toBe('tool')
      expect(msgs[0].name).toBe('bash')
      expect(msgs[0].summary).toBe('ran ls')
    })

    it('upserts on re-save', () => {
      const s = createSession()
      saveMessages(s.id, [{ id: 'msg-1', role: 'user', text: 'Original' }])
      saveMessages(s.id, [{ id: 'msg-1', role: 'user', text: 'Updated' }])
      const msgs = getMessages(s.id)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].text).toBe('Updated')
    })

    it('removes stale messages', () => {
      const s = createSession()
      saveMessages(s.id, [
        { id: 'a', role: 'user', text: 'Keep' },
        { id: 'b', role: 'meta', kind: 'thinking', text: '' },
      ])
      // Re-save without the empty thinking message
      saveMessages(s.id, [{ id: 'a', role: 'user', text: 'Keep' }])
      expect(getMessages(s.id)).toHaveLength(1)
    })

    it('blocks catastrophic message loss', () => {
      const s = createSession()
      const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `msg-${i}`, role: 'user', text: `Message ${i}` }))
      saveMessages(s.id, msgs)

      // Try to save only 2 messages (loss of 8 > threshold of 5)
      const result = saveMessages(s.id, [{ id: 'msg-0', role: 'user', text: 'Message 0' }])
      expect(result).toBe(false)
      // Original messages preserved
      expect(getMessages(s.id)).toHaveLength(10)
    })

    it('returns false for nonexistent session', () => {
      expect(saveMessages('fake', [{ id: 'a', role: 'user', text: 'x' }])).toBe(false)
    })
  })

  describe('pending approvals', () => {
    it('saves and retrieves pending approval', () => {
      const s = createSession()
      savePendingApproval(s.id, {
        kind: 'tool_approval',
        sessionId: s.id,
        requestId: 'req-1',
        toolName: 'bash',
        input: { command: 'ls' },
        title: 'Run command',
        description: 'List files',
      } as any)

      const approvals = getPendingApprovals(s.id)
      expect(approvals).toHaveLength(1)
      expect(approvals[0].requestId).toBe('req-1')
      expect(approvals[0].toolName).toBe('bash')
    })

    it('ignores non-approval chunks', () => {
      const s = createSession()
      savePendingApproval(s.id, { kind: 'text', text: 'hello' } as any)
      expect(getPendingApprovals(s.id)).toHaveLength(0)
    })

    it('removes specific approval', () => {
      const s = createSession()
      savePendingApproval(s.id, {
        kind: 'tool_approval', sessionId: s.id, requestId: 'req-1', toolName: 'bash',
      } as any)
      removePendingApproval('req-1')
      expect(getPendingApprovals(s.id)).toHaveLength(0)
    })

    it('clears all session approvals', () => {
      const s = createSession()
      savePendingApproval(s.id, { kind: 'tool_approval', sessionId: s.id, requestId: 'r1', toolName: 'a' } as any)
      savePendingApproval(s.id, { kind: 'tool_approval', sessionId: s.id, requestId: 'r2', toolName: 'b' } as any)
      clearSessionPendingApprovals(s.id)
      expect(getPendingApprovals(s.id)).toHaveLength(0)
    })
  })
})
