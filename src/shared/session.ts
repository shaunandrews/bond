export interface Session {
  id: string
  title: string
  summary: string
  archived: boolean
  createdAt: string   // ISO 8601
  updatedAt: string   // ISO 8601
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
}
