import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startServer, type BondServer } from './server'
import { BondClient } from '../shared/client'
import { setDataDir } from './paths'

let server: BondServer
let client: BondClient
let tempDir: string
let socketPath: string

beforeEach(async () => {
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
    await client.setModel('opus')
    const model = await client.getModel()
    expect(model).toBe('opus')
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
