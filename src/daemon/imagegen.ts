/**
 * Bond glue around the bundled pi-codex-image-gen Pi extension.
 *
 * The package registers `codex_generate_image`, a tool that generates or
 * edits images with gpt-image-2 through the ChatGPT/Codex subscription
 * already connected in Pi — no API key. Bond disables the package's own disk
 * writes and install telemetry (env defaults in daemon main.ts) and instead
 * persists generated images itself into the Bond image store, so they show
 * up in the transcript and Library like any other image.
 *
 * The package's npm `exports` map only exposes its telemetry helper; the
 * extension entry is the root index.ts, loaded by file path the same way
 * Pi's own package system does.
 */

import type { ImageMediaType } from '../shared/session'
import { saveImage } from './images'
import { ensureGlobalTranscriptSession, GLOBAL_TRANSCRIPT_SESSION_ID } from './sessions'

export { default as codexImageGenExtension } from '../../node_modules/pi-codex-image-gen/index'

export const IMAGEGEN_TOOL_NAMES = ['codex_generate_image']

/** The Codex image tool rides the ChatGPT/Codex subscription OAuth login. */
export function imageGenAvailable(providers: Array<{ providerId: string; type: 'api_key' | 'oauth' }>): boolean {
  return providers.some(({ providerId, type }) => providerId === 'openai-codex' && type === 'oauth')
}

interface ImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

function isImageBlock(block: unknown): block is ImageBlock {
  const value = block as Record<string, unknown> | null
  return !!value && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string'
}

const KNOWN_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Pull generated image payloads out of a Pi tool result's content blocks. */
export function extractResultImages(result: unknown): Array<{ data: string; mediaType: ImageMediaType }> {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return []
  return content.filter(isImageBlock).map(block => ({
    data: block.data,
    mediaType: (KNOWN_MEDIA_TYPES.includes(block.mimeType) ? block.mimeType : 'image/png') as ImageMediaType,
  }))
}

/**
 * Persist a codex_generate_image result's images into the Bond image store
 * and return their ids. Generated images belong to the continuous transcript,
 * which has no per-session row — `images.session_id` is a NOT NULL foreign
 * key, so the stable global-transcript owner row must exist first, exactly
 * like chat attachments (regression: saving under the epoch's Pi session
 * UUID failed with "FOREIGN KEY constraint failed").
 */
export function saveGeneratedImages(result: unknown): string[] {
  const images = extractResultImages(result)
  if (!images.length) return []
  ensureGlobalTranscriptSession()
  return images.map(image => saveImage(GLOBAL_TRANSCRIPT_SESSION_ID, image.data, image.mediaType).id)
}

/** Alt/caption text for a generated image: the backend's revised prompt. */
export function extractRevisedPrompt(result: unknown): string | undefined {
  const details = (result as { details?: { revisedPrompt?: unknown } } | null)?.details
  return typeof details?.revisedPrompt === 'string' ? details.revisedPrompt : undefined
}

/** Replace base64 image payloads with placeholders for text-only previews. */
export function stripResultImageData(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content) || !content.some(isImageBlock)) return result
  return {
    ...(result as Record<string, unknown>),
    content: content.map(block => (isImageBlock(block) ? { ...block, data: `[${block.mimeType} omitted]` } : block)),
  }
}
