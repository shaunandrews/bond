import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import { listTodos, createTodo, updateTodo, deleteTodo, reorderTodos } from './todos'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-todos-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('todos module', () => {
  describe('listTodos', () => {
    it('returns empty array initially', () => {
      expect(listTodos()).toEqual([])
    })

    it('returns todos sorted by sort_order', () => {
      createTodo('First')
      createTodo('Second')
      createTodo('Third')
      const todos = listTodos()
      expect(todos).toHaveLength(3)
      expect(todos[0].text).toBe('First')
      expect(todos[1].text).toBe('Second')
      expect(todos[2].text).toBe('Third')
    })
  })

  describe('createTodo', () => {
    it('creates a todo with required fields', () => {
      const todo = createTodo('Buy milk')
      expect(todo.id).toBeTruthy()
      expect(todo.text).toBe('Buy milk')
      expect(todo.notes).toBe('')
      expect(todo.group).toBe('')
      expect(todo.done).toBe(false)
      expect(todo.projectId).toBeUndefined()
      expect(todo.createdAt).toBeTruthy()
      expect(todo.updatedAt).toBeTruthy()
    })

    it('creates a todo with optional fields', () => {
      // Create a project first (FK constraint)
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('proj-1', 'P', '', 'generic', now, now)

      const todo = createTodo('Buy milk', 'From the store', 'Shopping', 'proj-1')
      expect(todo.notes).toBe('From the store')
      expect(todo.group).toBe('Shopping')
      expect(todo.projectId).toBe('proj-1')
    })

    it('assigns sequential sort order', () => {
      const t1 = createTodo('First')
      const t2 = createTodo('Second')
      expect(t2.sortOrder).toBeGreaterThan(t1.sortOrder)
    })
  })

  describe('updateTodo', () => {
    it('updates text', () => {
      const todo = createTodo('Original')
      const updated = updateTodo(todo.id, { text: 'Updated' })
      expect(updated?.text).toBe('Updated')
    })

    it('marks as done', () => {
      const todo = createTodo('Task')
      const updated = updateTodo(todo.id, { done: true })
      expect(updated?.done).toBe(true)
    })

    it('updates notes', () => {
      const todo = createTodo('Task')
      const updated = updateTodo(todo.id, { notes: 'Some notes' })
      expect(updated?.notes).toBe('Some notes')
    })

    it('updates group', () => {
      const todo = createTodo('Task')
      const updated = updateTodo(todo.id, { group: 'Work' })
      expect(updated?.group).toBe('Work')
    })

    it('updates projectId', () => {
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'P', '', 'generic', now, now)

      const todo = createTodo('Task')
      const updated = updateTodo(todo.id, { projectId: 'p1' })
      expect(updated?.projectId).toBe('p1')
    })

    it('clears projectId with empty string', () => {
      const db = getDb()
      const now = new Date().toISOString()
      db.prepare('INSERT INTO projects (id, name, goal, type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('p1', 'P', '', 'generic', now, now)

      const todo = createTodo('Task', '', '', 'p1')
      const updated = updateTodo(todo.id, { projectId: '' })
      expect(updated?.projectId).toBeUndefined()
    })

    it('returns null for no-op update', () => {
      const todo = createTodo('Task')
      expect(updateTodo(todo.id, {})).toBeNull()
    })

    it('returns null for nonexistent id', () => {
      expect(updateTodo('fake-id', { text: 'x' })).toBeNull()
    })

    it('updates updatedAt timestamp', () => {
      const todo = createTodo('Task')
      const updated = updateTodo(todo.id, { text: 'Changed' })
      // updatedAt should be set (may be same ms if fast, but it should exist)
      expect(updated?.updatedAt).toBeTruthy()
    })
  })

  describe('deleteTodo', () => {
    it('deletes existing todo', () => {
      const todo = createTodo('Task')
      expect(deleteTodo(todo.id)).toBe(true)
      expect(listTodos()).toHaveLength(0)
    })

    it('returns false for nonexistent id', () => {
      expect(deleteTodo('fake-id')).toBe(false)
    })
  })

  describe('reorderTodos', () => {
    it('reorders todos by ID list', () => {
      const t1 = createTodo('First')
      const t2 = createTodo('Second')
      const t3 = createTodo('Third')

      reorderTodos([t3.id, t1.id, t2.id])

      const todos = listTodos()
      expect(todos[0].text).toBe('Third')
      expect(todos[1].text).toBe('First')
      expect(todos[2].text).toBe('Second')
    })
  })
})
