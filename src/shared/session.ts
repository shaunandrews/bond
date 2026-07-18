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
  quick?: boolean
  iconSeed?: number
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

// --- Collections ---

export type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect' | 'rating' | 'url' | 'tags' | 'image'

export interface FieldDef {
  name: string
  type: FieldType
  primary?: boolean
  options?: string[]     // for select/multiselect
  max?: number           // for rating (default 5)
  prefix?: string        // for number display (e.g. "$")
  suffix?: string        // for number display (e.g. "min", "%")
  default?: unknown      // default value for new items
}

export interface Collection {
  id: string
  name: string
  icon: string
  schema: FieldDef[]
  features: string[]   // e.g. ['comments', 'projectLink']
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface ItemComment {
  id: string
  itemId: string
  author: 'user' | 'bond'
  body: string
  createdAt: string   // ISO 8601
}

export interface CollectionItem {
  id: string
  collectionId: string
  data: Record<string, unknown>
  sortOrder: number
  comments?: ItemComment[]
  createdAt: string
  updatedAt: string
}
