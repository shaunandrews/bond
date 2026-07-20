// --- Library: durable documents + media assets ---

export type AssetKind = 'document' | 'media'
export type AssetFormat = 'markdown' | 'plaintext' | 'pdf' | 'html' | 'other' | 'image'

export interface LibraryAsset {
  id: string
  kind: AssetKind
  format: AssetFormat
  title: string
  filename: string
  mediaType: string
  sizeBytes: number
  managedPath: string
  sourceUrl?: string
  sourceSessionId?: string
  sourceMessageId?: string
  previewText?: string
  createdAt: string
  updatedAt: string
}

export interface AssetReference {
  id: string
  assetId: string
  collectionId: string
  itemId: string
  createdAt: string
}

export interface AssetBacklink {
  itemId: string
  collectionId: string
  collectionName: string
  itemKey: string | null
  itemLabel: string
}

export interface LibraryAddDocumentInput {
  title?: string
  filename: string
  mediaType: string
  format: AssetFormat
  data: string // base64
  sourceUrl?: string
  sourceSessionId?: string
  sourceMessageId?: string
}

export interface LibraryListFilter {
  kind?: AssetKind
  query?: string
}
