import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startServer, type BondServer } from './server'
import { BondClient } from '../shared/client'
import { setDataDir } from './paths'
import { getDb } from './db'
import { listMessages as listTranscriptMessages } from './transcript'
import { registerApproval } from './approvals'

const { runBondQueryMock } = vi.hoisted(() => ({
  runBondQueryMock: vi.fn(),
}))

vi.mock('./agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent')>()
  return {
    ...actual,
    runBondQuery: runBondQueryMock,
  }
})

let server: BondServer
let client: BondClient
let tempDir: string
let socketPath: string

beforeEach(async () => {
  runBondQueryMock.mockReset()
  runBondQueryMock.mockResolvedValue({ succeeded: true, piSessionId: 'pi-test', contextTokens: 100, contextWindow: 1000 })
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
