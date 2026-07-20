import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startServer, type BondServer } from '../daemon/server'
import { setDataDir } from '../daemon/paths'
import { PROTOCOL_VERSION } from './protocol'
import { BondClient } from './client'

let server: BondServer
let client: BondClient
let tempDir: string
let socketPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bond-client-test-'))
  socketPath = join(tempDir, 'bond.sock')
  setDataDir(tempDir)
})

afterEach(async () => {
  client?.close()
  await server?.close()
  rmSync(tempDir, { recursive: true, force: true })
})

/** Resolve once a subscription-style listener fires, then unregister it. */
function nextEvent(register: (fn: () => void) => () => void): Promise<void> {
  return new Promise((resolve) => {
    const unregister = register(() => {
      unregister()
      resolve()
    })
  })
}

async function restartServer(token: string): Promise<void> {
  // Kill live connections the way a dying daemon does — wss.close() alone
  // would wait politely for the client we deliberately keep attached.
  for (const ws of server.wss.clients) ws.terminate()
  await server.close()
  // A closed unix-socket server usually unlinks its path, but not on every
  // teardown ordering — clear it so the restart never hits EADDRINUSE.
  rmSync(socketPath, { force: true })
  server = startServer(socketPath, token)
}

describe('BondClient auth', () => {
  it('authenticates with a plain string token and captures the protocol version', async () => {
    server = startServer(socketPath, 'token-a')
    client = new BondClient(socketPath, 'token-a')
    expect(client.daemonProtocolVersion).toBeNull()
    await client.connect()
    await expect(client.listSessions()).resolves.toEqual([])
    expect(client.daemonProtocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('rejects connect with a wrong token', async () => {
    server = startServer(socketPath, 'token-a')
    client = new BondClient(socketPath, 'wrong')
    await expect(client.connect()).rejects.toThrow()
  })
})

describe('BondClient reconnect', () => {
  it('reconnects in place with a fresh token and keeps registered listeners', async () => {
    // Regression: `bin/bond rebuild daemon` while the app was open used to
    // recreate the BondClient (new token lived in the constructor), silently
    // orphaning every push listener until app relaunch.
    let currentToken = 'token-a'
    server = startServer(socketPath, currentToken)
    client = new BondClient(socketPath, () => currentToken)
    await client.connect()

    const firstNotification = nextEvent((fn) => client.onCollectionsChanged(fn))
    await client.createCollection('Before restart', [{ name: 'title', type: 'text', primary: true }])
    await firstNotification

    currentToken = 'token-b'
    await restartServer(currentToken)
    await client.reconnect()

    // RPC works against the restarted daemon...
    const collections = await client.listCollections()
    expect(collections).toHaveLength(1)

    // ...and the listener registered before the restart still fires.
    const secondNotification = nextEvent((fn) => client.onCollectionsChanged(fn))
    await client.createCollection('After restart', [{ name: 'title', type: 'text', primary: true }])
    await secondNotification
  })

  it('rejects reconnect while the provider still returns the stale token', async () => {
    const staleToken = 'token-a'
    server = startServer(socketPath, staleToken)
    client = new BondClient(socketPath, () => staleToken)
    await client.connect()

    await restartServer('token-b')
    await expect(client.reconnect()).rejects.toThrow()
  })
})
