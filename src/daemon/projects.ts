import { randomUUID } from 'node:crypto'
import type { Project, ProjectResource, ProjectType } from '../shared/session'
import { getDb } from './db'

// --- Row types ---

interface ProjectRow {
  id: string
  name: string
  goal: string
  type: string
  archived: number
  deadline: string | null
  created_at: string
  updated_at: string
}

interface ResourceRow {
  id: string
  project_id: string
  kind: string
  value: string
  label: string | null
  created_at: string
}

function rowToResource(r: ResourceRow): ProjectResource {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as ProjectResource['kind'],
    value: r.value,
    label: r.label ?? undefined,
    createdAt: r.created_at,
  }
}

function getResourcesForProject(db: ReturnType<typeof getDb>, projectId: string): ProjectResource[] {
  const rows = db
    .prepare('SELECT id, project_id, kind, value, label, created_at FROM project_resources WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as ResourceRow[]
  return rows.map(rowToResource)
}

function rowToProject(db: ReturnType<typeof getDb>, r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    goal: r.goal,
    type: r.type as ProjectType,
    archived: r.archived === 1,
    deadline: r.deadline || undefined,
    resources: getResourcesForProject(db, r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// --- CRUD ---

const PROJECT_COLS = 'id, name, goal, type, archived, deadline, created_at, updated_at'

export function listProjects(): Project[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT ${PROJECT_COLS} FROM projects ORDER BY updated_at DESC`)
    .all() as ProjectRow[]
  return rows.map((r) => rowToProject(db, r))
}

export function getProject(id: string): Project | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`)
    .get(id) as ProjectRow | undefined
  return row ? rowToProject(db, row) : null
}

export function createProject(name: string, goal = '', type: ProjectType = 'generic', deadline?: string): Project {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO projects (id, name, goal, type, archived, deadline, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, name, goal, type, deadline ?? null, now, now)
  return { id, name, goal, type, archived: false, deadline: deadline || undefined, resources: [], createdAt: now, updatedAt: now }
}

export function updateProject(
  id: string,
  updates: Partial<Pick<Project, 'name' | 'goal' | 'type' | 'archived' | 'deadline'>>
): Project | null {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name) }
  if (updates.goal !== undefined) { sets.push('goal = ?'); values.push(updates.goal) }
  if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type) }
  if (updates.archived !== undefined) { sets.push('archived = ?'); values.push(updates.archived ? 1 : 0) }
  if (updates.deadline !== undefined) { sets.push('deadline = ?'); values.push(updates.deadline || null) }
  if (sets.length === 0) return getProject(id)

  const now = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(now)
  values.push(id)

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getProject(id)
}

export function deleteProject(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  return result.changes > 0
}

// --- Resources ---

export function addResource(projectId: string, kind: ProjectResource['kind'], value: string, label?: string): ProjectResource {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO project_resources (id, project_id, kind, value, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, kind, value, label ?? null, now)

  // Touch project updated_at
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId)

  return { id, projectId, kind, value, label, createdAt: now }
}

export function removeResource(resourceId: string): boolean {
  const db = getDb()

  // Get project_id before delete to touch updated_at
  const row = db.prepare('SELECT project_id FROM project_resources WHERE id = ?').get(resourceId) as { project_id: string } | undefined
  const result = db.prepare('DELETE FROM project_resources WHERE id = ?').run(resourceId)

  if (result.changes > 0 && row) {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), row.project_id)
  }

  return result.changes > 0
}
