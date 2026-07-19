import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { codexImageGenExtension, extractResultImages, extractRevisedPrompt, IMAGEGEN_TOOL_NAMES, imageGenAvailable, saveGeneratedImages, stripResultImageData } from './imagegen'
import { setDataDir } from './paths'
import { closeDb, getDb } from './db'
import { getImage } from './images'
import { GLOBAL_TRANSCRIPT_SESSION_ID } from './sessions'

const imageResult = {
  content: [
    { type: 'text', text: 'Generated image via openai-codex/gpt-5.5.' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ],
  details: { provider: 'openai-codex', revisedPrompt: 'A watercolor fox' },
}

describe('codexImageGenExtension', () => {
  // Regression: the package's npm exports map only exposes its telemetry
  // helper — the extension factory must come from the root index.ts by path.
  it('re-exports the package extension factory', () => {
    expect(typeof codexImageGenExtension).toBe('function')
  })
})

describe('imageGenAvailable', () => {
  it('requires the openai-codex subscription OAuth login', () => {
    expect(imageGenAvailable([{ providerId: 'openai-codex', type: 'oauth' }])).toBe(true)
    expect(imageGenAvailable([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai-codex', type: 'oauth' },
    ])).toBe(true)
  })

  it('stays off for anthropic-only, API-key, or empty credentials', () => {
    expect(imageGenAvailable([{ providerId: 'anthropic', type: 'oauth' }])).toBe(false)
    expect(imageGenAvailable([{ providerId: 'openai-codex', type: 'api_key' }])).toBe(false)
    expect(imageGenAvailable([])).toBe(false)
  })
})

describe('extractResultImages', () => {
  it('pulls image blocks out of a tool result', () => {
    expect(extractResultImages(imageResult)).toEqual([{ data: 'aGVsbG8=', mediaType: 'image/png' }])
  })

  it('falls back to png for unrecognized media types', () => {
    const result = { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/avif' }] }
    expect(extractResultImages(result)).toEqual([{ data: 'aGVsbG8=', mediaType: 'image/png' }])
  })

  it('returns nothing for text-only, string, or malformed results', () => {
    expect(extractResultImages({ content: [{ type: 'text', text: 'ok' }] })).toEqual([])
    expect(extractResultImages('plain output')).toEqual([])
    expect(extractResultImages(null)).toEqual([])
    expect(extractResultImages({ content: [{ type: 'image', data: 42 }] })).toEqual([])
  })
})

describe('extractRevisedPrompt', () => {
  it('reads the revised prompt from result details when present', () => {
    expect(extractRevisedPrompt(imageResult)).toBe('A watercolor fox')
    expect(extractRevisedPrompt({ details: {} })).toBeUndefined()
    expect(extractRevisedPrompt('plain output')).toBeUndefined()
  })
})

describe('stripResultImageData', () => {
  it('replaces base64 payloads with a placeholder and keeps everything else', () => {
    const stripped = stripResultImageData(imageResult) as typeof imageResult
    expect(stripped.content[0]).toEqual(imageResult.content[0])
    expect(stripped.content[1]).toEqual({ type: 'image', data: '[image/png omitted]', mimeType: 'image/png' })
    expect(stripped.details).toEqual(imageResult.details)
    // The original result (which feeds the model) is untouched.
    expect(imageResult.content[1].data).toBe('aGVsbG8=')
  })

  it('passes image-free results through unchanged', () => {
    const textResult = { content: [{ type: 'text', text: 'ok' }] }
    expect(stripResultImageData(textResult)).toBe(textResult)
    expect(stripResultImageData('plain output')).toBe('plain output')
  })
})

describe('saveGeneratedImages', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `bond-test-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    setDataDir(testDir)
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(testDir, { recursive: true, force: true })
    setDataDir(null as unknown as string)
  })

  // Regression: saving under the epoch's Pi session UUID (not a sessions row)
  // hit "FOREIGN KEY constraint failed" — the generated image silently
  // vanished from the transcript. Generated images belong to the continuous
  // transcript's stable owner row, created on demand like chat attachments.
  it('saves under the global transcript session, creating the owner row on demand', () => {
    const [id] = saveGeneratedImages(imageResult)

    expect(id).toBeTruthy()
    expect(getImage(id)).toEqual({ data: 'aGVsbG8=', mediaType: 'image/png' })
    const row = getDb().prepare('SELECT session_id FROM images WHERE id = ?').get(id) as { session_id: string }
    expect(row.session_id).toBe(GLOBAL_TRANSCRIPT_SESSION_ID)
  })

  it('does nothing for image-free results', () => {
    expect(saveGeneratedImages({ content: [{ type: 'text', text: 'ok' }] })).toEqual([])
    expect(saveGeneratedImages('plain output')).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 })
  })
})

describe('IMAGEGEN_TOOL_NAMES', () => {
  it('names the codex_generate_image tool', () => {
    expect(IMAGEGEN_TOOL_NAMES).toEqual(['codex_generate_image'])
  })
})
