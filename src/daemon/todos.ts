import { randomUUID } from 'node:crypto'
import type { TodoItem } from '../shared/session'
import { getDb } from './db'

interface TodoRow {
  id: string
  text: string
  done: number
  created_at: string
  updated_at: string
}

function rowToTodo(r: TodoRow): TodoItem {
  return { id: r.id, text: r.text, done: r.done === 1, createdAt: r.created_at, updatedAt: r.updated_at }
}

export function listTodos(): TodoItem[] {
  const db = getDb()
  const rows = db.prepare('SELECT id, text, done, created_at, updated_at FROM todos ORDER BY created_at ASC').all() as TodoRow[]
  return rows.map(rowToTodo)
}

export function createTodo(text: string): TodoItem {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO todos (id, text, done, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(id, text, now, now)
  return { id, text, done: false, createdAt: now, updatedAt: now }
}

export function updateTodo(id: string, updates: Partial<Pick<TodoItem, 'text' | 'done'>>): TodoItem | null {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (updates.text !== undefined) { sets.push('text = ?'); values.push(updates.text) }
  if (updates.done !== undefined) { sets.push('done = ?'); values.push(updates.done ? 1 : 0) }
  if (sets.length === 0) return null

  const now = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(now)
  values.push(id)

  db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  const row = db.prepare('SELECT id, text, done, created_at, updated_at FROM todos WHERE id = ?').get(id) as TodoRow | undefined
  return row ? rowToTodo(row) : null
}

export function deleteTodo(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM todos WHERE id = ?').run(id)
  return result.changes > 0
}
