export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof ACCEPTED_IMAGE_TYPES)[number]

export interface AttachedImage {
  data: string          // base64-encoded (no data URI prefix)
  mediaType: ImageMediaType
}

export function imageDataUri(img: AttachedImage): string {
  return `data:${img.mediaType};base64,${img.data}`
}

export type EditMode =
  | { type: 'full' }
  | { type: 'readonly' }
  | { type: 'scoped'; allowedPaths: string[] }

export const DEFAULT_EDIT_MODE: EditMode = { type: 'full' }

export interface Session {
  id: string
  title: string
  summary: string
  archived: boolean
  favorited: boolean
  iconSeed?: number
  editMode: EditMode
  projectId?: string  // optional link to a project
  createdAt: string   // ISO 8601
  updatedAt: string   // ISO 8601
}

export interface ImageRecord {
  id: string
  sessionId: string
  filename: string
  mediaType: ImageMediaType
  sizeBytes: number
  createdAt: string
}

export interface TodoItem {
  id: string
  text: string
  notes: string
  group: string
  done: boolean
  projectId?: string  // optional link to a project
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface SessionMessage {
  id: string
  role: string
  text?: string
  streaming?: boolean
  kind?: string
  name?: string
  summary?: string
  status?: string
  images?: AttachedImage[]
  imageIds?: string[]
}

// --- Projects ---

export type ProjectType = 'wordpress' | 'web' | 'presentation' | 'generic'

export interface ProjectResource {
  id: string
  projectId: string
  kind: 'path' | 'file' | 'link'
  value: string        // filesystem path or URL
  label?: string       // optional display name
  createdAt: string
}

export interface Project {
  id: string
  name: string
  goal: string
  type: ProjectType
  archived: boolean
  deadline?: string   // ISO 8601 date (YYYY-MM-DD), optional
  resources: ProjectResource[]
  createdAt: string
  updatedAt: string
}
