import { ref, computed, watch } from 'vue'
import type { Project, ProjectType, ProjectResource } from '../../shared/session'

const PROJECT_STORAGE_KEY = 'bond:activeProjectId'

export interface ProjectDeps {
  listProjects: () => Promise<Project[]>
  getProject: (id: string) => Promise<Project | null>
  createProject: (name: string, goal?: string, type?: ProjectType, deadline?: string) => Promise<Project>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'goal' | 'type' | 'archived' | 'deadline'>>) => Promise<Project | null>
  deleteProject: (id: string) => Promise<boolean>
  addProjectResource: (projectId: string, kind: ProjectResource['kind'], value: string, label?: string) => Promise<ProjectResource>
  removeProjectResource: (id: string) => Promise<boolean>
  onProjectsChanged: (fn: () => void) => () => void
}

export function useProjects(deps: ProjectDeps = window.bond) {
  const projects = ref<Project[]>([])
  const activeProjectId = ref<string | null>(localStorage.getItem(PROJECT_STORAGE_KEY))
  const loading = ref(false)

  watch(activeProjectId, (id) => {
    if (id) localStorage.setItem(PROJECT_STORAGE_KEY, id)
    else localStorage.removeItem(PROJECT_STORAGE_KEY)
  })

  const activeProjects = computed(() =>
    projects.value.filter((p) => !p.archived)
  )

  const archivedProjects = computed(() =>
    projects.value.filter((p) => p.archived)
  )

  const activeProject = computed(() =>
    projects.value.find((p) => p.id === activeProjectId.value) ?? null
  )

  async function load() {
    loading.value = true
    try {
      projects.value = await deps.listProjects()
    } finally {
      loading.value = false
    }
  }

  async function create(name: string, goal?: string, type?: ProjectType, deadline?: string): Promise<Project> {
    const project = await deps.createProject(name, goal, type, deadline)
    projects.value.unshift(project)
    activeProjectId.value = project.id
    return project
  }

  function select(id: string | null) {
    activeProjectId.value = id
  }

  async function archive(id: string) {
    const updated = await deps.updateProject(id, { archived: true })
    if (updated) {
      const idx = projects.value.findIndex((p) => p.id === id)
      if (idx !== -1) projects.value[idx] = updated
      if (activeProjectId.value === id) {
        const next = activeProjects.value[0]
        activeProjectId.value = next?.id ?? null
      }
    }
  }

  async function unarchive(id: string) {
    const updated = await deps.updateProject(id, { archived: false })
    if (updated) {
      const idx = projects.value.findIndex((p) => p.id === id)
      if (idx !== -1) projects.value[idx] = updated
    }
  }

  async function update(id: string, updates: Partial<Pick<Project, 'name' | 'goal' | 'type' | 'deadline'>>) {
    const updated = await deps.updateProject(id, updates)
    if (updated) {
      const idx = projects.value.findIndex((p) => p.id === id)
      if (idx !== -1) projects.value[idx] = updated
    }
    return updated
  }

  async function remove(id: string) {
    const ok = await deps.deleteProject(id)
    if (ok) {
      projects.value = projects.value.filter((p) => p.id !== id)
      if (activeProjectId.value === id) {
        const next = activeProjects.value[0]
        activeProjectId.value = next?.id ?? null
      }
    }
  }

  async function addResource(projectId: string, kind: ProjectResource['kind'], value: string, label?: string) {
    const resource = await deps.addProjectResource(projectId, kind, value, label)
    const idx = projects.value.findIndex((p) => p.id === projectId)
    if (idx !== -1) {
      projects.value[idx] = {
        ...projects.value[idx],
        resources: [...projects.value[idx].resources, resource]
      }
    }
    return resource
  }

  async function removeResource(projectId: string, resourceId: string) {
    const ok = await deps.removeProjectResource(resourceId)
    if (ok) {
      const idx = projects.value.findIndex((p) => p.id === projectId)
      if (idx !== -1) {
        projects.value[idx] = {
          ...projects.value[idx],
          resources: projects.value[idx].resources.filter((r) => r.id !== resourceId)
        }
      }
    }
  }

  function updateLocal(id: string, updates: Partial<Project>) {
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx !== -1) {
      projects.value[idx] = { ...projects.value[idx], ...updates }
    }
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    activeProjects,
    archivedProjects,
    loading,
    load,
    create,
    select,
    archive,
    unarchive,
    update,
    remove,
    addResource,
    removeResource,
    updateLocal
  }
}
