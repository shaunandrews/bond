import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { useProjects, type ProjectDeps } from './useProjects'
import type { Project, ProjectResource } from '../../shared/session'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'Test', goal: '', type: 'generic', archived: false,
    resources: [], createdAt: '2025-01-01', updatedAt: '2025-01-01',
    ...overrides,
  }
}

function mockDeps(): ProjectDeps {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue(null),
    createProject: vi.fn().mockResolvedValue(makeProject()),
    updateProject: vi.fn().mockResolvedValue(makeProject()),
    deleteProject: vi.fn().mockResolvedValue(true),
    addProjectResource: vi.fn().mockResolvedValue({ id: 'r1', projectId: 'p1', kind: 'file', value: '/a', createdAt: '' }),
    removeProjectResource: vi.fn().mockResolvedValue(true),
    onProjectsChanged: vi.fn().mockReturnValue(vi.fn()),
  }
}

type UseProjectsReturn = ReturnType<typeof useProjects>

function withSetup(deps: ProjectDeps): UseProjectsReturn {
  let result!: UseProjectsReturn
  const app = createApp(
    defineComponent({
      setup() {
        result = useProjects(deps)
        return () => null
      },
    })
  )
  app.mount(document.createElement('div'))
  return result
}

describe('useProjects', () => {
  let deps: ProjectDeps
  let projects: UseProjectsReturn

  beforeEach(() => {
    localStorage.clear()
    deps = mockDeps()
    projects = withSetup(deps)
  })

  describe('load', () => {
    it('fetches projects from deps', async () => {
      const data = [makeProject({ id: 'p1' }), makeProject({ id: 'p2', archived: true })]
      ;(deps.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue(data)

      await projects.load()
      expect(projects.projects.value).toHaveLength(2)
      expect(projects.activeProjects.value).toHaveLength(1)
      expect(projects.archivedProjects.value).toHaveLength(1)
    })

    it('sets and clears loading state', async () => {
      let resolveFn: (v: Project[]) => void
      ;(deps.listProjects as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise(r => { resolveFn = r })
      )

      const promise = projects.load()
      expect(projects.loading.value).toBe(true)
      resolveFn!([])
      await promise
      expect(projects.loading.value).toBe(false)
    })
  })

  describe('create', () => {
    it('adds project to list and selects it', async () => {
      const newProject = makeProject({ id: 'new-1', name: 'New' })
      ;(deps.createProject as ReturnType<typeof vi.fn>).mockResolvedValue(newProject)

      const result = await projects.create('New')
      expect(result.name).toBe('New')
      expect(projects.projects.value).toHaveLength(1)
      expect(projects.activeProjectId.value).toBe('new-1')
    })
  })

  describe('select', () => {
    it('updates activeProjectId', () => {
      projects.select('p1')
      expect(projects.activeProjectId.value).toBe('p1')
    })

    it('clears with null', () => {
      projects.select('p1')
      projects.select(null)
      expect(projects.activeProjectId.value).toBeNull()
    })
  })

  describe('archive', () => {
    it('updates project in list', async () => {
      const p = makeProject({ id: 'p1' })
      projects.projects.value = [p]
      projects.activeProjectId.value = 'p1'

      const archived = { ...p, archived: true }
      ;(deps.updateProject as ReturnType<typeof vi.fn>).mockResolvedValue(archived)

      await projects.archive('p1')
      expect(projects.projects.value[0].archived).toBe(true)
      // Active selection should clear since it was archived
      expect(projects.activeProjectId.value).toBeNull()
    })
  })

  describe('unarchive', () => {
    it('updates project in list', async () => {
      const p = makeProject({ id: 'p1', archived: true })
      projects.projects.value = [p]

      const unarchived = { ...p, archived: false }
      ;(deps.updateProject as ReturnType<typeof vi.fn>).mockResolvedValue(unarchived)

      await projects.unarchive('p1')
      expect(projects.projects.value[0].archived).toBe(false)
    })
  })

  describe('update', () => {
    it('updates project fields in list', async () => {
      const p = makeProject({ id: 'p1', name: 'Old' })
      projects.projects.value = [p]

      const updated = { ...p, name: 'New' }
      ;(deps.updateProject as ReturnType<typeof vi.fn>).mockResolvedValue(updated)

      await projects.update('p1', { name: 'New' })
      expect(projects.projects.value[0].name).toBe('New')
    })
  })

  describe('remove', () => {
    it('removes project from list', async () => {
      projects.projects.value = [makeProject({ id: 'p1' })]
      projects.activeProjectId.value = 'p1'

      await projects.remove('p1')
      expect(projects.projects.value).toHaveLength(0)
      expect(projects.activeProjectId.value).toBeNull()
    })
  })

  describe('addResource', () => {
    it('adds resource to project in list', async () => {
      projects.projects.value = [makeProject({ id: 'p1', resources: [] })]

      const resource: ProjectResource = { id: 'r1', projectId: 'p1', kind: 'file', value: '/a', createdAt: '' }
      ;(deps.addProjectResource as ReturnType<typeof vi.fn>).mockResolvedValue(resource)

      await projects.addResource('p1', 'file', '/a')
      expect(projects.projects.value[0].resources).toHaveLength(1)
    })
  })

  describe('removeResource', () => {
    it('removes resource from project in list', async () => {
      const resource: ProjectResource = { id: 'r1', projectId: 'p1', kind: 'file', value: '/a', createdAt: '' }
      projects.projects.value = [makeProject({ id: 'p1', resources: [resource] })]

      await projects.removeResource('p1', 'r1')
      expect(projects.projects.value[0].resources).toHaveLength(0)
    })
  })

  describe('updateLocal', () => {
    it('updates project in list without API call', () => {
      projects.projects.value = [makeProject({ id: 'p1', name: 'Old' })]
      projects.updateLocal('p1', { name: 'New' })
      expect(projects.projects.value[0].name).toBe('New')
    })
  })

  describe('computed', () => {
    it('activeProject resolves from list', () => {
      projects.projects.value = [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })]
      projects.activeProjectId.value = 'p2'
      expect(projects.activeProject.value?.id).toBe('p2')
    })

    it('activeProject returns null when no match', () => {
      projects.projects.value = [makeProject({ id: 'p1' })]
      projects.activeProjectId.value = 'unknown'
      expect(projects.activeProject.value).toBeNull()
    })
  })
})
