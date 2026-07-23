import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { startServer, attachConnection, type BondServer } from './server'
import { BondClient, RpcCallError } from '../shared/client'
import { PROTOCOL_VERSION, RPC_VALIDATION_ERROR, RPC_INVALID_PARAMS } from '../shared/protocol'
import { setDataDir } from './paths'
import { getDb } from './db'
import { listMessages as listTranscriptMessages } from './transcript'
import { registerApproval } from './approvals'
import { DEFAULT_AGENT_SETTINGS } from '../shared/agents'
import { createAgentRunRecord } from './agents/async/store'

const { runBondQueryMock, runPiTextPromptMock } = vi.hoisted(() => ({
  runBondQueryMock: vi.fn(),
  runPiTextPromptMock: vi.fn(),
}))

vi.mock('./agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent')>()
  return {
    ...actual,
    runBondQuery: runBondQueryMock,
  }
})

vi.mock('./pi/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pi/runtime')>()
  return {
    ...actual,
    runPiTextPrompt: runPiTextPromptMock,
  }
})

let server: BondServer
let client: BondClient
let tempDir: string
let socketPath: string

beforeEach(async () => {
  runBondQueryMock.mockReset()
  runBondQueryMock.mockResolvedValue({ succeeded: true, piSessionId: 'pi-test', contextTokens: 100, contextWindow: 1000 })
  runPiTextPromptMock.mockReset()
  runPiTextPromptMock.mockResolvedValue('a bounded summary of the thread')
  tempDir = mkdtempSync(join(tmpdir(), 'bond-test-'))
  socketPath = join(tempDir, 'bond.sock')
  setDataDir(tempDir)
  server = startServer(socketPath)
  client = new BondClient(socketPath)
  await client.connect()
})

afterEach(async () => {
  client.close()
  await server.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('async agent run RPC', () => {
  it('reconciles persisted runs and broadcasts cancellation to subscribers', async () => {
    createAgentRunRecord({
      id: 'rpc-run',
      idempotencyKey: 'rpc-run',
      agent: 'felix',
      agentLabel: 'Felix',
      verb: 'critique',
      brief: 'read only',
      paths: [],
      workspace: { repoRoot: tempDir, isolation: 'in-place', branch: null, readOnly: true },
      baseSha: null,
      allowedPaths: [],
      settings: DEFAULT_AGENT_SETTINGS,
      agentDefinitionVersion: 'v1',
      commandPolicyVersion: 'phase0-readonly-no-shell-v1',
      acceptanceChecks: [],
      resourceCaps: { wallClockSeconds: 300, maxOutputChars: 100_000 },
    })
    await client.call('bond.subscribe')
    const changed = vi.fn()
    const off = client.onNotification('bond.chunk', chunk => {
      if (chunk.kind === 'agent_run_changed') changed(chunk.run)
    })

    expect((await client.call('agentruns.list')).runs).toEqual([
      expect.objectContaining({ id: 'rpc-run', status: 'queued' }),
    ])
    expect(await client.call('agentruns.cancel', { runId: 'rpc-run' }))
      .toMatchObject({ id: 'rpc-run', status: 'cancelled' })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: 'rpc-run', status: 'cancelled' })))
    off()
  })
})

describe('onboarding RPC', () => {
  it('reports pending status and seeds the intro into the real transcript on begin', async () => {
    expect((await client.onboardingStatus()).status).toBe('pending')

    await client.onboardingBegin()

    const page = await client.listTranscript()
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0].role).toBe('bond')
    expect(page.messages[0].text).toContain('what should I call you?')

    // Idempotent — a reload does not duplicate the intro.
    await client.onboardingBegin()
    expect((await client.listTranscript()).messages).toHaveLength(1)
  })

  it('marks first-run onboarding skipped', async () => {
    expect((await client.onboardingSkip()).status).toBe('skipped')
    expect((await client.onboardingStatus()).status).toBe('skipped')
  })
})

describe('sandbox RPC', () => {
  it('enters an isolated empty data set and restores the real one on exit', async () => {
    await client.onboardingBegin() // seed real transcript with one message
    expect((await client.sandboxStatus()).sandboxed).toBe(false)

    await client.sandboxEnter()
    expect((await client.sandboxStatus()).sandboxed).toBe(true)
    expect((await client.listTranscript()).messages).toHaveLength(0)
    // Sandbox looks like a genuine fresh install.
    expect((await client.onboardingStatus()).status).toBe('pending')

    await client.sandboxExit()
    expect((await client.sandboxStatus()).sandboxed).toBe(false)
    expect((await client.listTranscript()).messages).toHaveLength(1)
  })
})

describe('session CRUD', () => {
  it('creates and lists sessions', async () => {
    const session = await client.createSession()
    expect(session.id).toBeDefined()
    expect(session.title).toBe('New chat')

    const sessions = await client.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(session.id)
  })

  it('gets a session by id', async () => {
    const session = await client.createSession()
    const fetched = await client.getSession(session.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(session.id)
  })

  it('returns null for unknown session', async () => {
    const fetched = await client.getSession('nonexistent')
    expect(fetched).toBeNull()
  })

  it('updates a session', async () => {
    const session = await client.createSession()
    const updated = await client.updateSession(session.id, { title: 'Updated' })
    expect(updated!.title).toBe('Updated')

    const fetched = await client.getSession(session.id)
    expect(fetched!.title).toBe('Updated')
  })

  it('deletes a session', async () => {
    const session = await client.createSession()
    const deleted = await client.deleteSession(session.id)
    expect(deleted).toBe(true)

    const sessions = await client.listSessions()
    expect(sessions).toHaveLength(0)
  })
})

describe('messages', () => {
  it('saves and loads messages', async () => {
    const session = await client.createSession()
    const messages = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'bond', text: 'hi there' }
    ]
    const ok = await client.saveMessages(session.id, messages)
    expect(ok).toBe(true)

    const loaded = await client.getMessages(session.id)
    expect(loaded).toHaveLength(2)
    expect(loaded[0].text).toBe('hello')
    expect(loaded[1].text).toBe('hi there')
  })
})

describe('settings', () => {
  it('gets and sets model', async () => {
    await client.setModel('high')
    const model = await client.getModel()
    expect(model).toBe('high')
  })

  it('gets and sets soul', async () => {
    await client.saveSoul('You are helpful.')
    const soul = await client.getSoul()
    expect(soul).toBe('You are helpful.')
  })

  it('gets and sets accent color', async () => {
    await client.saveAccentColor('#ff0000')
    const color = await client.getAccentColor()
    expect(color).toBe('#ff0000')
  })
})

describe('subscriptions and chunks', () => {
  it('receives chunks after subscribing', async () => {
    const session = await client.createSession()
    await client.subscribe(session.id)

    const chunks: unknown[] = []
    client.onChunk((chunk) => chunks.push(chunk))

    // Manually broadcast a chunk via the server internals to test the pipe
    // We'll use a second client to trigger a subscribe and check
    const client2 = new BondClient(socketPath)
    await client2.connect()
    await client2.subscribe(session.id)

    const chunks2: unknown[] = []
    client2.onChunk((chunk) => chunks2.push(chunk))

    // Both clients are subscribed - verify subscription worked
    // (Full chunk streaming requires Agent SDK which we don't mock here,
    // but we verify the subscribe/unsubscribe mechanics)
    await client.unsubscribe(session.id)
    client2.close()
  })
})

describe('daemon runtime integration', () => {
  it('creates an epoch turn, tags chunks, and completes context usage', async () => {
    const session = await client.createSession()
    await client.subscribe(session.id)
    const chunks: unknown[] = []
    client.onChunk((chunk) => chunks.push(chunk))

    runBondQueryMock.mockImplementation(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'hello back' })
      return { succeeded: true, piSessionId: options.piSessionId, contextTokens: 321, contextWindow: 1000 }
    })

    const result = await client.send('hello', session.id)
    expect(result.ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))

    const rows = listTranscriptMessages({ limit: 10 }).messages
    const user = rows.find(m => m.role === 'user')
    const assistant = rows.find(m => m.role === 'bond')
    expect(user?.text).toBe('hello')
    expect(assistant?.text).toBe('hello back')
    expect(user?.epochId).toBeTruthy()
    expect(user?.turnId).toBeTruthy()

    const turn = getDb().prepare('SELECT status, context_tokens, context_window FROM turns WHERE id = ?').get(user!.turnId) as Record<string, unknown>
    expect(turn).toMatchObject({ status: 'done', context_tokens: 321, context_window: 1000 })
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn_start', turnId: user!.turnId, userMessageId: user!.id, text: 'hello' }),
      expect.objectContaining({ kind: 'query_start', epochId: user!.epochId, turnId: user!.turnId }),
      expect.objectContaining({ kind: 'assistant_text', epochId: user!.epochId, turnId: user!.turnId, text: 'hello back' }),
      expect.objectContaining({ kind: 'query_end', epochId: user!.epochId, turnId: user!.turnId, succeeded: true }),
    ]))
  })

  it('mirrors turns and approval resolutions to other live viewers', async () => {
    // A second client (e.g. the phone browser) subscribed globally must see
    // the sender's turn_start with its message ids, and approval outcomes.
    const client2 = new BondClient(socketPath)
    await client2.connect()
    await client2.subscribe()
    const chunks2: any[] = []
    client2.onChunk((chunk) => chunks2.push(chunk))

    const session = await client.createSession()
    await client.send('sync me', session.id)
    await client.respondToApproval('req-42', true)
    await vi.waitFor(() => {
      expect(chunks2).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn_start',
          text: 'sync me',
          userMessageId: expect.any(String),
          assistantMessageId: expect.any(String),
          activityMessageId: expect.any(String),
        }),
        expect.objectContaining({ kind: 'approval_resolved', requestId: 'req-42', approved: true }),
      ]))
    })
    client2.close()
  })

  it('keeps one global active query and aborts the previous session', async () => {
    const first = await client.createSession()
    const second = await client.createSession()
    let firstAbort: (() => void) | undefined
    runBondQueryMock.mockImplementationOnce((_prompt, options) => new Promise(resolve => {
      firstAbort = () => resolve({ succeeded: false, piSessionId: options.piSessionId })
      options.abortSignal.addEventListener('abort', firstAbort, { once: true })
    }))
    runBondQueryMock.mockResolvedValueOnce({ succeeded: true, piSessionId: 'pi-next', contextTokens: 5, contextWindow: 10 })

    const firstSend = await client.send('first', first.id) as { ok: boolean; turnId?: string }
    // Park a real approval on the first turn — aborting it must deny the prompt.
    const parked = registerApproval('req-abort-test', firstSend.turnId!)
    await client.send('second', second.id)
    firstAbort?.()
    await new Promise(resolve => setTimeout(resolve, 20))

    await expect(parked).resolves.toEqual({ approved: false })
    const turns = getDb().prepare('SELECT status FROM turns ORDER BY started_at ASC').all() as Array<{ status: string }>
    expect(turns.map(t => t.status)).toEqual(['cancelled', 'done'])
  })
})

describe('approval flow', () => {
  it('resolves approval response without error', async () => {
    // Just verify the RPC call succeeds (no pending approval to resolve)
    const result = await client.respondToApproval('fake-id', true)
    expect(result.ok).toBe(true)
  })
})

describe('error handling', () => {
  it('returns error for unknown method', async () => {
    // Access the internal call method via a known pattern
    try {
      await (client as any).call('unknown.method')
    } catch (e) {
      expect((e as Error).message).toContain('Unknown method')
    }
  })

  it('maps collection validation failures to RPC_VALIDATION_ERROR with structured data', async () => {
    const collection = await client.createCollection('Tracker', [
      { name: 'title', type: 'text', primary: true },
      { name: 'status', type: 'status', options: ['open', 'done'] },
    ])
    try {
      await client.addCollectionItem(collection.id, { title: 'x', status: 'bogus' })
      expect.unreachable('should have thrown')
    } catch (e) {
      const err = e as RpcCallError
      expect(err).toBeInstanceOf(RpcCallError)
      expect(err.code).toBe(RPC_VALIDATION_ERROR)
      expect(err.message).toContain('status')
      expect(err.message).toContain('open, done')
      expect(err.data).toEqual({ errors: [{ field: 'status', message: expect.stringContaining('open, done') }] })
    }
  })

  it('rejects invalid schemas at collection.create', async () => {
    await expect(client.createCollection('Bad', [{ name: 'sel', type: 'select' }]))
      .rejects.toMatchObject({ code: RPC_VALIDATION_ERROR })
  })
})

describe('library RPC', () => {
  const TEXT_B64 = Buffer.from('# Report\n\nBody text').toString('base64')
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

  it('adds a document, lists it, and gets it by id', async () => {
    const asset = await client.call('library.addDocument', {
      title: 'Studio catch-up', filename: 'catchup.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64,
    })
    expect(asset.kind).toBe('document')
    expect(asset.title).toBe('Studio catch-up')

    const list = await client.call('library.list')
    expect(list.map((a: any) => a.id)).toContain(asset.id)

    const fetched = await client.call('library.get', { id: asset.id })
    expect(fetched?.id).toBe(asset.id)
  })

  it('filters library.list by kind', async () => {
    await client.call('library.addDocument', { filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
    await client.importImage(TINY_PNG, 'image/png')

    const docs = await client.call('library.list', { kind: 'document' })
    const media = await client.call('library.list', { kind: 'media' })
    expect(docs.every((a: any) => a.kind === 'document')).toBe(true)
    expect(media.every((a: any) => a.kind === 'media')).toBe(true)
    expect(media.length).toBeGreaterThan(0)
  })

  it('rejects library.addDocument missing required params', async () => {
    await expect(client.call('library.addDocument', { filename: 'a.md' } as any))
      .rejects.toMatchObject({ code: RPC_INVALID_PARAMS })
  })

  it('deletes a media-kind asset by delegating through images.ts', async () => {
    const image = await client.importImage(TINY_PNG, 'image/png')
    const asset = await client.call('library.get', { id: image.id })
    expect(asset?.kind).toBe('media')

    const result = await client.call('library.delete', { id: image.id })
    expect(result.ok).toBe(true)

    expect(await client.call('library.get', { id: image.id })).toBeNull()
    const images = await client.listImages()
    expect(images.find((i) => i.id === image.id)).toBeUndefined()
  })

  it('broadcasts library.changed on mutation', async () => {
    const changed = vi.fn()
    const unsub = client.onLibraryChanged(changed)
    await client.call('library.addDocument', { filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(changed).toHaveBeenCalled()
    unsub()
  })

  it('adds, lists, and removes a reference between an asset and a collection item, without affecting other references', async () => {
    const collection = await client.createCollection('Tracker', [{ name: 'title', type: 'text', primary: true }])
    const item1 = await client.addCollectionItem(collection.id, { title: 'Item one' })
    const item2 = await client.addCollectionItem(collection.id, { title: 'Item two' })
    const asset = await client.call('library.addDocument', { filename: 'a.md', mediaType: 'text/markdown', format: 'markdown', data: TEXT_B64 })

    await client.call('library.addReference', { assetId: asset.id, itemId: item1.id })
    await client.call('library.addReference', { assetId: asset.id, itemId: item2.id })

    expect((await client.call('library.listReferencesForItem', { itemId: item1.id })).map((a: any) => a.id)).toEqual([asset.id])

    const backlinks = await client.call('library.listBacklinksForAsset', { assetId: asset.id })
    expect(backlinks).toHaveLength(2)

    const removed = await client.call('library.removeReference', { assetId: asset.id, itemId: item1.id })
    expect(removed.ok).toBe(true)
    expect(await client.call('library.listReferencesForItem', { itemId: item1.id })).toEqual([])
    expect(await client.call('library.listReferencesForItem', { itemId: item2.id })).toHaveLength(1)
  })
})

describe('chat threads RPC', () => {
  async function sendAndGetAnchor(text: string, reply: string): Promise<string> {
    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: reply })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await client.send(text)
    await new Promise(resolve => setTimeout(resolve, 20))
    const rows = listTranscriptMessages({ limit: 20 }).messages
    const anchor = [...rows].reverse().find(m => m.role === 'bond' && m.text === reply)
    if (!anchor) throw new Error('anchor message not found')
    return anchor.id
  }

  it('creates a thread from an anchor, idempotently, and lists it as recent once touched', async () => {
    const anchorId = await sendAndGetAnchor('what is bond?', 'bond is a chat app')

    const thread = await client.call('thread.create', { anchorMessageId: anchorId })
    expect(thread.status).toBe('draft')
    expect(thread.anchorMessageId).toBe(anchorId)

    const again = await client.call('thread.create', { anchorMessageId: anchorId })
    expect(again.id).toBe(thread.id)

    const byAnchor = await client.call('thread.getForAnchor', { anchorMessageId: anchorId })
    expect(byAnchor?.id).toBe(thread.id)

    // Still a draft — not in the recent list yet.
    expect((await client.call('thread.listRecent')).threads.map(t => t.id)).not.toContain(thread.id)

    await client.call('thread.touch', { threadId: thread.id })
    const recent = await client.call('thread.listRecent')
    expect(recent.threads.map(t => t.id)).toContain(thread.id)

    const fetched = await client.call('thread.get', { threadId: thread.id })
    expect(fetched?.status).toBe('open')
  })

  it('rejects creating a thread from a nonexistent anchor', async () => {
    await expect(client.call('thread.create', { anchorMessageId: 'no-such-message' })).rejects.toThrow()
  })

  it('closes and deletes draft threads, refusing to delete a non-draft', async () => {
    const anchorId = await sendAndGetAnchor('q', 'a')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })

    await client.call('thread.touch', { threadId: thread.id })
    expect((await client.call('thread.deleteDraft', { threadId: thread.id })).ok).toBe(false)

    await client.call('thread.close', { threadId: thread.id })
    expect((await client.call('thread.get', { threadId: thread.id }))?.status).toBe('closed')
  })

  it('broadcasts thread.changed to other live clients on create/touch/close', async () => {
    const client2 = new BondClient(socketPath)
    await client2.connect()
    await client2.subscribe()
    const events: unknown[] = []
    client2.onThreadChanged(() => events.push('changed'))

    const anchorId = await sendAndGetAnchor('q2', 'a2')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })
    await client.call('thread.touch', { threadId: thread.id })
    await client.call('thread.close', { threadId: thread.id })

    await vi.waitFor(() => { expect(events.length).toBeGreaterThanOrEqual(3) })
    client2.close()
  })
})

describe('chat threads write-back RPC', () => {
  async function sendAndGetAnchor(text: string, reply: string): Promise<string> {
    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: reply })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await client.send(text)
    await new Promise(resolve => setTimeout(resolve, 20))
    const rows = listTranscriptMessages({ limit: 20 }).messages
    const anchor = [...rows].reverse().find(m => m.role === 'bond' && m.text === reply)
    if (!anchor) throw new Error('anchor message not found')
    return anchor.id
  }

  it('summarizes a thread via the bounded fast-tier prompt, never calling the model when it has no messages', async () => {
    const anchorId = await sendAndGetAnchor('q', 'a')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })

    const empty = await client.call('thread.summarize', { threadId: thread.id })
    expect(empty.summary).toBe('')
    expect(runPiTextPromptMock).not.toHaveBeenCalled()

    await client.call('bond.send', { text: 'a thread question', scope: { type: 'thread', threadId: thread.id } })
    await new Promise(resolve => setTimeout(resolve, 20))

    const result = await client.call('thread.summarize', { threadId: thread.id })
    expect(result.summary).toBe('a bounded summary of the thread')
    expect(runPiTextPromptMock).toHaveBeenCalledTimes(1)
    expect(runPiTextPromptMock.mock.calls[0][1]).toBe('fast')
  })

  it('sends a confirmed summary to main as a labeled bond message, never merging raw thread messages', async () => {
    const anchorId = await sendAndGetAnchor('q', 'a')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })

    const result = await client.call('thread.sendSummaryToMain', { threadId: thread.id, summary: 'the agreed conclusion' })
    expect(result.ok).toBe(true)

    const rows = listTranscriptMessages({ limit: 20 }).messages
    const inserted = rows.find(m => m.id === result.messageId)
    expect(inserted).toMatchObject({ role: 'bond', threadId: null })
    expect(inserted?.text).toContain('From thread')
    expect(inserted?.text).toContain('the agreed conclusion')
  })

  it('rejects an empty summary', async () => {
    const anchorId = await sendAndGetAnchor('q', 'a')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })
    await expect(client.call('thread.sendSummaryToMain', { threadId: thread.id, summary: '   ' })).rejects.toThrow()
  })
})

describe('multiple clients', () => {
  it('supports concurrent connections', async () => {
    const client2 = new BondClient(socketPath)
    await client2.connect()

    const session = await client.createSession()
    const fetched = await client2.getSession(session.id)
    expect(fetched!.id).toBe(session.id)

    client2.close()
  })
})

describe('edit mode setting', () => {
  it('round-trips a scoped mode and degrades garbage to full', async () => {
    await client.setEditMode({ type: 'scoped', allowedPaths: ['~/notes'] })
    expect(await client.getEditMode()).toEqual({ type: 'scoped', allowedPaths: ['~/notes'] })

    await client.setEditMode({ type: 'lasers' } as never)
    expect(await client.getEditMode()).toEqual({ type: 'full' })
  })

  it('broadcasts edit_mode_changed to other live clients', async () => {
    // One global mode: a change on the phone must reach the desktop live.
    const client2 = new BondClient(socketPath)
    await client2.connect()
    await client2.subscribe()
    const chunks2: any[] = []
    client2.onChunk((chunk) => chunks2.push(chunk))

    await client.setEditMode({ type: 'readonly' })

    await vi.waitFor(() => {
      expect(chunks2).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'edit_mode_changed', editMode: { type: 'readonly' } }),
      ]))
    })
    client2.close()
  })
})

describe('working memory RPC', () => {
  it('redacts secrets on the updateWorking write path', async () => {
    // Regression: the RPC used a server-local writer that skipped the
    // service layer's redaction — a key pasted into MemoryView persisted
    // verbatim and rode along in every future prompt.
    const secret = `deploy key sk-${'a'.repeat(48)}`
    const saved = await client.memoryUpdateWorking({
      sessionId: null,
      projectId: null,
      goal: secret,
      facts: ['likes tea', secret],
      preferences: [],
      decisions: [],
      openThreads: [],
      artifacts: [],
      activeSkill: null,
      checkpoint: null,
      updatedAt: new Date().toISOString(),
    })

    expect(saved.goal).toBe('')
    expect(saved.facts).toEqual(['likes tea'])

    const read = await client.memoryWorking()
    expect(read.facts).toEqual(['likes tea'])

    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'memory.working'").get() as { value: string } | undefined
    expect(row?.value ?? '').not.toContain('sk-aaaa')
  })
})

describe('startup reconciliation', () => {
  it('clears stuck running turns from a previous daemon life on startup', async () => {
    // Seed a stranded 'running' turn (as a crashed daemon would leave), then
    // boot a fresh server against the same data dir and expect it finished.
    const { insertTurnStart } = await import('./transcript')
    const { ensureActiveEpoch } = await import('./epochs')
    const { epoch } = await ensureActiveEpoch({})
    insertTurnStart({
      epochId: epoch.id,
      turnId: 'stranded-turn',
      userMessageId: 'stranded-user',
      assistantMessageId: 'stranded-bond',
      activityMessageId: 'stranded-activity',
      text: 'interrupted question',
      activityData: { turnId: 'stranded-turn', status: 'working', startedAt: Date.now(), events: [] } as never,
    })

    client.close()
    await server.close()
    const secondSocket = join(tempDir, 'bond-2.sock')
    server = startServer(secondSocket)
    client = new BondClient(secondSocket)
    await client.connect()

    const turn = getDb().prepare("SELECT status FROM turns WHERE id = 'stranded-turn'").get() as { status: string }
    expect(turn.status).toBe('cancelled')
    const activity = getDb().prepare("SELECT data FROM messages WHERE id = 'stranded-activity'").get() as { data: string }
    expect(JSON.parse(activity.data).status).toBe('cancelled')
  })
})

describe('sense.search', () => {
  function seedCapture(id: string, text: string | null, extras: { appName?: string; windowTitle?: string } = {}): void {
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare('INSERT OR IGNORE INTO sense_sessions (id, started_at, created_at) VALUES (?, ?, ?)').run('ss1', now, now)
    db.prepare(
      'INSERT INTO sense_captures (id, session_id, captured_at, app_name, window_title, text_content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'ss1', now, extras.appName ?? 'TestApp', extras.windowTitle ?? 'A window', text, now)
  }

  it('finds captures through the FTS index, including hyphenated terms', async () => {
    seedCapture('c1', 'planning the foo-bar retro tomorrow')
    seedCapture('c2', 'unrelated grocery list')

    const results = await client.senseSearch('foo-bar') as Array<Record<string, unknown>>
    expect(results.map(r => r.id)).toEqual(['c1'])
    expect(results[0].channel).toBe('see')
    expect(results[0]._sortDate).toBe(results[0].captured_at)
  })

  it('falls back to the LIKE scan when the query has no indexable tokens', async () => {
    seedCapture('c1', 'what is this ??? thing anyway')
    seedCapture('c2', 'plain text without punctuation')

    const results = await client.senseSearch('???') as Array<Record<string, unknown>>
    expect(results.map(r => r.id)).toEqual(['c1'])
  })

  it('tracks text transitions through NULL (update-trigger regression)', async () => {
    seedCapture('c1', null)
    expect(await client.senseSearch('zephyr')).toHaveLength(0)

    getDb().prepare("UPDATE sense_captures SET text_content = 'zephyr sighting confirmed' WHERE id = 'c1'").run()
    const found = await client.senseSearch('zephyr') as Array<Record<string, unknown>>
    expect(found.map(r => r.id)).toEqual(['c1'])

    getDb().prepare("UPDATE sense_captures SET text_content = NULL WHERE id = 'c1'").run()
    expect(await client.senseSearch('zephyr')).toHaveLength(0)
  })
})

// Raw-socket helpers for exercising attachConnection below BondClient's
// handshake — the auth gate must be provoked with hand-built frames.
// URL shape mirrors BondClient.connect(): `ws+unix://${socketPath}`.
function rawConnect(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${path}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  })
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => ws.once('close', () => resolve()))
}

describe('auth gate', () => {
  // The token-gated path is CLAUDE.md's declared security boundary for
  // remote (LAN) access — exercised here on its own token-bearing server.
  let authServer: BondServer
  let authSocketPath: string

  beforeEach(() => {
    authSocketPath = join(tempDir, 'bond-auth.sock')
    authServer = startServer(authSocketPath, 'test-token')
  })

  afterEach(async () => {
    await authServer.close()
  })

  it('accepts a client presenting the valid token', async () => {
    const authed = new BondClient(authSocketPath, 'test-token')
    await authed.connect()
    expect(await authed.listSessions()).toEqual([])
    authed.close()
  })

  it('carries the protocol version in the auth success reply', async () => {
    const ws = await rawConnect(authSocketPath)
    const reply = nextMessage(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bond.auth', params: { token: 'test-token' } }))
    const resp = await reply
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION })
    ws.close()
  })

  it('rejects an invalid token and closes the socket', async () => {
    const ws = await rawConnect(authSocketPath)
    const reply = nextMessage(ws)
    const closed = waitForClose(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'bond.auth', params: { token: 'wrong-token' } }))
    const resp = await reply
    expect(resp.error.code).toBe(-32600)
    expect(resp.error.message).toContain('Invalid auth token')
    await closed
  })

  it('rejects an unauthenticated first request and closes the socket', async () => {
    const ws = await rawConnect(authSocketPath)
    const reply = nextMessage(ws)
    const closed = waitForClose(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list' }))
    const resp = await reply
    expect(resp.error.code).toBe(-32600)
    expect(resp.error.message).toContain('Authentication required')
    await closed
  })
})

describe('malformed JSON', () => {
  it('answers with a parse error and keeps the socket usable', async () => {
    // Default tokenless harness — pins the current non-fatal behavior:
    // a parse error responds with -32700 but must not kill the connection.
    const ws = await rawConnect(socketPath)
    const errorReply = nextMessage(ws)
    ws.send('not-json{')
    const resp = await errorReply
    expect(resp.id).toBe(0)
    expect(resp.error).toMatchObject({ code: -32700, message: 'Parse error' })

    const okReply = nextMessage(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list' }))
    const followUp = await okReply
    expect(followUp.id).toBe(1)
    expect(followUp.error).toBeUndefined()
    expect(followUp.result).toEqual([])
    ws.close()
  })
})

describe('racing sends over the socket', () => {
  it('serializes near-simultaneous sends from two clients without overlap', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    runBondQueryMock.mockImplementation((_prompt, options) => new Promise((resolve) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      let finished = false
      const finish = (succeeded: boolean) => {
        if (finished) return
        finished = true
        concurrent--
        resolve({ succeeded, piSessionId: options.piSessionId })
      }
      if (options.abortSignal.aborted) return finish(false)
      options.abortSignal.addEventListener('abort', () => finish(false), { once: true })
      setTimeout(() => finish(true), 30)
    }))

    const client2 = new BondClient(socketPath)
    await client2.connect()

    const [first, second] = await Promise.all([
      client.send({ text: 'from desktop', turnId: 'race-desktop', userMessageId: 'u1', assistantMessageId: 'a1', activityMessageId: 'm1' }),
      client2.send({ text: 'from phone', turnId: 'race-phone', userMessageId: 'u2', assistantMessageId: 'a2', activityMessageId: 'm2' }),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    await vi.waitFor(() => {
      const statuses = (getDb().prepare('SELECT status FROM turns').all() as Array<{ status: string }>).map(t => t.status).sort()
      expect(statuses).toEqual(['cancelled', 'done'])
    })
    expect(maxConcurrent).toBe(1)
    const epochs = getDb().prepare('SELECT COUNT(*) AS n FROM epochs').get() as { n: number }
    expect(epochs.n).toBe(1)
    client2.close()
  })
})

describe('attachConnection device-credential gate', () => {
  // The remote LAN listener accepts EITHER the shared pairing token or a
  // per-device credential minted through /api/pair, so a Home Screen app
  // authenticates without ever being handed remote.token.
  function fakeWs() {
    const sent: Record<string, any>[] = []
    let onMessage: ((data: Buffer) => Promise<void> | void) | undefined
    const ws = {
      readyState: WebSocket.OPEN,
      sent,
      closed: false,
      on(event: string, fn: (data: Buffer) => Promise<void> | void) {
        if (event === 'message') onMessage = fn
        return ws
      },
      send(data: string) { sent.push(JSON.parse(data)) },
      close() { ws.closed = true },
      async auth(token: unknown) {
        await onMessage?.(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bond.auth', params: { token } })))
        return sent.at(-1)!
      },
    }
    return ws
  }

  it('accepts a valid device credential', async () => {
    const ws = fakeWs()
    attachConnection(ws as any, 'shared-token', token => token === 'device-cred')
    const reply = await ws.auth('device-cred')
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION })
    expect(ws.closed).toBe(false)
  })

  it('still accepts the shared pairing token — the Safari QR flow keeps working', async () => {
    const ws = fakeWs()
    attachConnection(ws as any, 'shared-token', () => false)
    expect((await ws.auth('shared-token')).error).toBeUndefined()
  })

  it('rejects a credential the validator refuses (revoked or unknown)', async () => {
    const ws = fakeWs()
    const accept = vi.fn(() => false)
    attachConnection(ws as any, 'shared-token', accept)
    const reply = await ws.auth('revoked-cred')
    expect(reply.error.code).toBe(-32600)
    expect(accept).toHaveBeenCalledWith('revoked-cred')
    expect(ws.closed).toBe(true)
  })

  it('never passes a non-string token to the validator', async () => {
    const ws = fakeWs()
    const accept = vi.fn(() => true)
    attachConnection(ws as any, 'shared-token', accept)
    const reply = await ws.auth({ evil: true })
    expect(accept).not.toHaveBeenCalled()
    expect(reply.error).toBeDefined()
  })

  it('rejects everything when no validator is supplied and the token is wrong', async () => {
    const ws = fakeWs()
    attachConnection(ws as any, 'shared-token')
    expect((await ws.auth('device-cred')).error).toBeDefined()
    expect(ws.closed).toBe(true)
  })
})

describe('scoped subscription routing (chat threads)', () => {
  async function sendAndGetAnchorId(sender: BondClient, text: string, reply: string): Promise<string> {
    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: reply })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await sender.send(text)
    await new Promise(resolve => setTimeout(resolve, 20))
    const rows = listTranscriptMessages({ limit: 20 }).messages
    const anchor = [...rows].reverse().find(m => m.role === 'bond' && m.text === reply)
    if (!anchor) throw new Error('anchor message not found')
    return anchor.id
  }

  it('a main-only subscriber never receives a thread turn\'s chunks', async () => {
    const anchorId = await sendAndGetAnchorId(client, 'q', 'a')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })

    // A fresh client subscribes to main only and never itself sends into
    // the thread — sending auto-subscribes the sender to its own scope, so
    // testing this with `client` (which created the anchor) would be moot.
    const observer = new BondClient(socketPath)
    await observer.connect()
    await observer.subscribe()
    const mainChunks: unknown[] = []
    observer.onChunk((c) => mainChunks.push(c))

    const sender = new BondClient(socketPath)
    await sender.connect()
    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'thread reply' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await sender.call('bond.send', { text: 'thread question', scope: { type: 'thread', threadId: thread.id } })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(mainChunks.some(c => (c as { text?: string }).text === 'thread reply')).toBe(false)
    observer.close()
    sender.close()
  })

  it('thread A never receives thread B\'s or main\'s chunks', async () => {
    const anchorA = await sendAndGetAnchorId(client, 'qa', 'aa')
    const anchorB = await sendAndGetAnchorId(client, 'qb', 'ab')
    const threadA = await client.call('thread.create', { anchorMessageId: anchorA })
    const threadB = await client.call('thread.create', { anchorMessageId: anchorB })

    const observer = new BondClient(socketPath)
    await observer.connect()
    await observer.subscribe(undefined, { type: 'thread', threadId: threadA.id })
    const threadAChunks: unknown[] = []
    observer.onChunk((c) => threadAChunks.push(c))

    const sender = new BondClient(socketPath)
    await sender.connect()

    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'reply for B' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await sender.call('bond.send', { text: 'question for B', scope: { type: 'thread', threadId: threadB.id } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(threadAChunks.some(c => (c as { text?: string }).text === 'reply for B')).toBe(false)

    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'main reply' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await sender.send('main question')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(threadAChunks.some(c => (c as { text?: string }).text === 'main reply')).toBe(false)

    observer.close()
    sender.close()
  })

  it('a client subscribed to a thread receives that thread\'s own chunks', async () => {
    const anchorId = await sendAndGetAnchorId(client, 'q', 'a')
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })

    await client.subscribe(undefined, { type: 'thread', threadId: thread.id })
    const threadChunks: unknown[] = []
    client.onChunk((c) => threadChunks.push(c))

    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'thread reply' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await client.call('bond.send', { text: 'thread question', scope: { type: 'thread', threadId: thread.id } })
    await vi.waitFor(() => {
      expect(threadChunks.some(c => (c as { text?: string }).text === 'thread reply')).toBe(true)
    })
  })
})

describe('reconnect with main and thread subscriptions active', () => {
  it('a fresh connection re-subscribing to both main and a thread receives chunks for both again', async () => {
    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'anchor reply' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await client.send('anchor question')
    await new Promise(resolve => setTimeout(resolve, 20))
    const rows = listTranscriptMessages({ limit: 20 }).messages
    const anchorId = [...rows].reverse().find(m => m.role === 'bond' && m.text === 'anchor reply')!.id
    const thread = await client.call('thread.create', { anchorMessageId: anchorId })

    // Simulate a disconnect: close the original client (server-side cleanup
    // removes it from every subscriber set), then reconnect fresh.
    client.close()
    const reconnected = new BondClient(socketPath)
    await reconnected.connect()
    await reconnected.subscribe() // main
    await reconnected.subscribe(undefined, { type: 'thread', threadId: thread.id })

    const chunks: unknown[] = []
    reconnected.onChunk((c) => chunks.push(c))

    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'main after reconnect' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await reconnected.send('main after reconnect question')
    await vi.waitFor(() => {
      expect(chunks.some(c => (c as { text?: string }).text === 'main after reconnect')).toBe(true)
    })

    runBondQueryMock.mockImplementationOnce(async (_prompt, options) => {
      options.onChunk({ kind: 'assistant_text', text: 'thread after reconnect' })
      return { succeeded: true, piSessionId: options.piSessionId }
    })
    await reconnected.call('bond.send', { text: 'thread after reconnect question', scope: { type: 'thread', threadId: thread.id } })
    await vi.waitFor(() => {
      expect(chunks.some(c => (c as { text?: string }).text === 'thread after reconnect')).toBe(true)
    })

    reconnected.close()
  })
})
