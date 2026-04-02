import { randomUUID } from 'node:crypto'
import type { TodoItem } from '../shared/session'
import { getDb } from './db'

interface TodoRow {
  id: string
  text: string
  notes: string
  group_name: string
  done: number
  project_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

function rowToTodo(r: TodoRow): TodoItem {
  return { id: r.id, text: r.text, notes: r.notes, group: r.group_name, done: r.done === 1, projectId: r.project_id || undefined, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at }
}

const TODO_COLS = 'id, text, notes, group_name, done, project_id, sort_order, created_at, updated_at'

export function listTodos(): TodoItem[] {
  const db = getDb()
  const rows = db.prepare(`SELECT ${TODO_COLS} FROM todos ORDER BY sort_order ASC, created_at ASC`).all() as TodoRow[]
  return rows.map(rowToTodo)
}

export function createTodo(text: string, notes = '', group = '', projectId?: string): TodoItem {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  // New todos go to the end
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM todos').get() as { m: number }).m
  const sortOrder = maxOrder + 1
  db.prepare('INSERT INTO todos (id, text, notes, group_name, done, project_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)').run(id, text, notes, group, projectId ?? null, sortOrder, now, now)
  return { id, text, notes, group, done: false, projectId: projectId || undefined, sortOrder, createdAt: now, updatedAt: now }
}

export function updateTodo(id: string, updates: Partial<Pick<TodoItem, 'text' | 'notes' | 'group' | 'done' | 'projectId'>>): TodoItem | null {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (updates.text !== undefined) { sets.push('text = ?'); values.push(updates.text) }
  if (updates.notes !== undefined) { sets.push('notes = ?'); values.push(updates.notes) }
  if (updates.group !== undefined) { sets.push('group_name = ?'); values.push(updates.group) }
  if (updates.done !== undefined) { sets.push('done = ?'); values.push(updates.done ? 1 : 0) }
  if (updates.projectId !== undefined) { sets.push('project_id = ?'); values.push(updates.projectId || null) }
  if (sets.length === 0) return null

  const now = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(now)
  values.push(id)

  db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  const row = db.prepare(`SELECT ${TODO_COLS} FROM todos WHERE id = ?`).get(id) as TodoRow | undefined
  return row ? rowToTodo(row) : null
}

export function deleteTodo(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM todos WHERE id = ?').run(id)
  return result.changes > 0
}

/** Reorder todos by providing an ordered list of IDs. Each ID gets a sequential sort_order. */
export function reorderTodos(orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE todos SET sort_order = ? WHERE id = ?')
  const run = db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id))
  })
  run()
}
