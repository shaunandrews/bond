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
  editMode: EditMode
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
  done: boolean
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
