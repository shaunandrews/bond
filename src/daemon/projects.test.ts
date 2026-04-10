import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from './paths'
import { getDb, closeDb } from './db'
import {
  listProjects, getProject, createProject, updateProject, deleteProject,
  addResource, removeResource,
} from './projects'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-projects-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as any)
})

describe('projects module', () => {
  describe('listProjects', () => {
    it('returns empty array initially', () => {
      expect(listProjects()).toEqual([])
    })

    it('returns all created projects', () => {
      createProject('Alpha')
      createProject('Beta')
      const projects = listProjects()
      expect(projects).toHaveLength(2)
      const names = projects.map(p => p.name)
      expect(names).toContain('Alpha')
      expect(names).toContain('Beta')
    })
  })

  describe('createProject', () => {
    it('creates with defaults', () => {
      const p = createProject('My Project')
      expect(p.id).toBeTruthy()
      expect(p.name).toBe('My Project')
      expect(p.goal).toBe('')
      expect(p.type).toBe('generic')
      expect(p.archived).toBe(false)
      expect(p.deadline).toBeUndefined()
      expect(p.resources).toEqual([])
    })

    it('creates with all fields', () => {
      const p = createProject('Site', 'Launch by EOW', 'wordpress', '2025-03-15')
      expect(p.goal).toBe('Launch by EOW')
      expect(p.type).toBe('wordpress')
      expect(p.deadline).toBe('2025-03-15')
    })
  })

  describe('getProject', () => {
    it('returns project by id', () => {
      const p = createProject('Test')
      const fetched = getProject(p.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.name).toBe('Test')
    })

    it('returns null for nonexistent id', () => {
      expect(getProject('fake')).toBeNull()
    })
  })

  describe('updateProject', () => {
    it('updates name', () => {
      const p = createProject('Old')
      const updated = updateProject(p.id, { name: 'New' })
      expect(updated?.name).toBe('New')
    })

    it('updates goal', () => {
      const p = createProject('P')
      const updated = updateProject(p.id, { goal: 'Ship it' })
      expect(updated?.goal).toBe('Ship it')
    })

    it('updates type', () => {
      const p = createProject('P')
      const updated = updateProject(p.id, { type: 'web' })
      expect(updated?.type).toBe('web')
    })

    it('archives project', () => {
      const p = createProject('P')
      const updated = updateProject(p.id, { archived: true })
      expect(updated?.archived).toBe(true)
    })

    it('updates deadline', () => {
      const p = createProject('P')
      const updated = updateProject(p.id, { deadline: '2025-06-01' })
      expect(updated?.deadline).toBe('2025-06-01')
    })

    it('clears deadline with empty string', () => {
      const p = createProject('P', '', 'generic', '2025-06-01')
      const updated = updateProject(p.id, { deadline: '' })
      expect(updated?.deadline).toBeUndefined()
    })

    it('returns project unchanged for empty updates', () => {
      const p = createProject('P')
      const result = updateProject(p.id, {})
      expect(result?.name).toBe('P')
    })

    it('returns null for nonexistent id', () => {
      expect(updateProject('fake', { name: 'x' })).toBeNull()
    })
  })

  describe('deleteProject', () => {
    it('deletes existing project', () => {
      const p = createProject('P')
      expect(deleteProject(p.id)).toBe(true)
      expect(getProject(p.id)).toBeNull()
    })

    it('returns false for nonexistent id', () => {
      expect(deleteProject('fake')).toBe(false)
    })
  })

  describe('resources', () => {
    it('adds resource to project', () => {
      const p = createProject('P')
      const r = addResource(p.id, 'path', '/src/app')
      expect(r.id).toBeTruthy()
      expect(r.projectId).toBe(p.id)
      expect(r.kind).toBe('path')
      expect(r.value).toBe('/src/app')
    })

    it('adds resource with label', () => {
      const p = createProject('P')
      const r = addResource(p.id, 'link', 'https://example.com', 'Docs')
      expect(r.label).toBe('Docs')
    })

    it('resources appear on project', () => {
      const p = createProject('P')
      addResource(p.id, 'file', '/readme.md')
      addResource(p.id, 'link', 'https://example.com')

      const fetched = getProject(p.id)
      expect(fetched!.resources).toHaveLength(2)
      expect(fetched!.resources[0].kind).toBe('file')
      expect(fetched!.resources[1].kind).toBe('link')
    })

    it('removes resource', () => {
      const p = createProject('P')
      const r = addResource(p.id, 'path', '/src')
      expect(removeResource(r.id)).toBe(true)

      const fetched = getProject(p.id)
      expect(fetched!.resources).toHaveLength(0)
    })

    it('returns false removing nonexistent resource', () => {
      expect(removeResource('fake')).toBe(false)
    })

    it('cascades on project delete', () => {
      const p = createProject('P')
      addResource(p.id, 'file', '/a')
      deleteProject(p.id)

      const db = getDb()
      const count = db.prepare('SELECT COUNT(*) as n FROM project_resources WHERE project_id = ?').get(p.id) as { n: number }
      expect(count.n).toBe(0)
    })
  })
})
