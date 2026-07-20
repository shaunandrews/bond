/** Pure helpers for `bond library` — split out from library.ts so they're testable without triggering its main() side effect on import. */

export interface LibraryAssetLike {
  id: string
}

/** Resolves a CLI query as a 1-based index into the just-fetched list, or a case-insensitive id-prefix match. */
export function findAsset<T extends LibraryAssetLike>(assets: T[], query: string): T | undefined {
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= assets.length) return assets[idx - 1]
  const lower = query.toLowerCase()
  return assets.find(a => a.id.toLowerCase().startsWith(lower))
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

export const EXT_TO_DOC: Record<string, { format: string; mediaType: string }> = {
  '.md': { format: 'markdown', mediaType: 'text/markdown' },
  '.markdown': { format: 'markdown', mediaType: 'text/markdown' },
  '.txt': { format: 'plaintext', mediaType: 'text/plain' },
  '.html': { format: 'html', mediaType: 'text/html' },
  '.htm': { format: 'html', mediaType: 'text/html' },
  '.pdf': { format: 'pdf', mediaType: 'application/pdf' },
}

export const CONTENT_TYPE_TO_FORMAT: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/plain': 'plaintext',
  'text/html': 'html',
  'application/pdf': 'pdf',
}

/** Best-effort format/mediaType detection for a local file, by extension, defaulting to 'other'. */
export function detectDocFormat(ext: string): { format: string; mediaType: string } {
  return EXT_TO_DOC[ext.toLowerCase()] ?? { format: 'other', mediaType: 'application/octet-stream' }
}

/** Same, but preferring an HTTP Content-Type header when it names a known document format. */
export function detectDocFormatFromResponse(contentType: string | undefined, urlExt: string): { format: string; mediaType: string } {
  if (contentType) {
    const format = CONTENT_TYPE_TO_FORMAT[contentType]
    if (format) return { format, mediaType: contentType }
  }
  const byExt = EXT_TO_DOC[urlExt.toLowerCase()]
  if (byExt) return byExt
  return { format: 'other', mediaType: contentType ?? 'application/octet-stream' }
}
