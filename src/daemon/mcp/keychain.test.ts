import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KeychainError,
  createKeychainStore,
  hasSecretRef,
  keychainStore as realKeychainStore,
  resolveSecrets,
  secretRefsIn,
  setSecretStore,
  toSecretRef,
  type RunSecurity,
  type SecurityResult,
} from './keychain'

/** Records every `security` invocation so we can assert on argv, not a shell string. */
const calls: string[][] = []
let nextResult: SecurityResult = { code: 0, stdout: '', stderr: '' }

/**
 * The runner is INJECTED, never module-mocked: an earlier version of this
 * test mocked node:child_process, the mock silently failed to apply, and the
 * suite wrote real items into the login keychain.
 */
const fakeRun: RunSecurity = async (args) => {
  calls.push(['security', ...args])
  return nextResult
}

const keychainStore = createKeychainStore(fakeRun)

type SecretStore = Parameters<typeof setSecretStore>[0]

/** An in-memory stand-in for the macOS Keychain. */
function fakeStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    async set(ref: string, value: string) { values.set(ref, value) },
    async get(ref: string) { return values.get(ref) ?? null },
    async remove(ref: string) { return values.delete(ref) },
    async list() { return [...values.keys()].sort() },
  }
}

function succeed(stdout = ''): void {
  nextResult = { code: 0, stdout, stderr: '' }
}

function fail(stderr = 'The specified item could not be found in the keychain.'): void {
  nextResult = { code: 44, stdout: '', stderr }
}

beforeEach(() => {
  calls.length = 0
  succeed()
  setSecretStore(fakeStore())
})

afterEach(() => {
  setSecretStore(realKeychainStore)
})

describe('secret references', () => {
  it('recognizes and builds keychain: references', () => {
    expect(hasSecretRef('keychain:my-token')).toBe(true)
    expect(hasSecretRef('Bearer abc')).toBe(false)
    expect(toSecretRef('my-token')).toBe('keychain:my-token')
  })

  // Regression: the guard used to require the value to START with the prefix,
  // so a header written the natural way shipped the literal string
  // "Bearer keychain:my-token" as the Authorization header.
  it('recognizes a reference embedded in a larger value', () => {
    expect(hasSecretRef('Bearer keychain:my-token')).toBe(true)
    expect(secretRefsIn({ Authorization: 'Bearer keychain:my-token' })).toEqual(['my-token'])
  })

  it('lists the refs in a value map without exposing values', () => {
    expect(secretRefsIn({ A: 'keychain:one', B: 'plain', C: 'keychain:one', D: 'Bearer keychain:two' }))
      .toEqual(['one', 'two'])
    expect(secretRefsIn(undefined)).toEqual([])
  })
})

describe('resolveSecrets', () => {
  it('leaves plain values alone', async () => {
    await expect(resolveSecrets({ 'X-Plain': 'value' })).resolves.toEqual({ 'X-Plain': 'value' })
    await expect(resolveSecrets(undefined)).resolves.toBeUndefined()
  })

  it('substitutes a stored secret', async () => {
    setSecretStore(fakeStore({ 'remote-token': 'sk-live-123' }))
    await expect(resolveSecrets({ Authorization: 'keychain:remote-token' }))
      .resolves.toEqual({ Authorization: 'sk-live-123' })
  })

  // Regression: this is how the CLI and Settings UI actually write the header.
  it('substitutes a reference embedded in a larger value', async () => {
    setSecretStore(fakeStore({ 'remote-token': 'sk-live-123' }))
    await expect(resolveSecrets({ Authorization: 'Bearer keychain:remote-token' }))
      .resolves.toEqual({ Authorization: 'Bearer sk-live-123' })
  })

  it('throws for an embedded reference with no stored secret', async () => {
    await expect(resolveSecrets({ Authorization: 'Bearer keychain:gone' })).rejects.toThrow(/No Keychain secret called "gone"/)
  })

  // A missing secret must be loud: silently sending an unauthenticated request
  // produces a confusing 401 instead of "your token is gone".
  it('throws when the secret is missing', async () => {
    await expect(resolveSecrets({ Authorization: 'keychain:gone' })).rejects.toBeInstanceOf(KeychainError)
    await expect(resolveSecrets({ Authorization: 'keychain:gone' })).rejects.toThrow(/No Keychain secret called "gone"/)
  })

  it('resolves several references in one map', async () => {
    setSecretStore(fakeStore({ one: 'a', two: 'b' }))
    await expect(resolveSecrets({ A: 'keychain:one', B: 'keychain:two', C: 'plain' }))
      .resolves.toEqual({ A: 'a', B: 'b', C: 'plain' })
  })
})

describe('in-memory store round-trip', () => {
  it('sets, reads, lists, and removes', async () => {
    const store = fakeStore()
    setSecretStore(store)

    await store.set('token', 'value')
    await expect(store.get('token')).resolves.toBe('value')
    await expect(store.list()).resolves.toEqual(['token'])
    await expect(store.remove('token')).resolves.toBe(true)
    await expect(store.remove('token')).resolves.toBe(false)
    await expect(store.get('token')).resolves.toBeNull()
  })
})

describe('keychainStore over the security CLI', () => {
  // The one real risk of shelling out: a secret must never be interpolated
  // into a command string where quoting could break (or leak) it.
  it('invokes the security binary with an argv array, never a shell', async () => {
    await keychainStore.set('remote-token', 'sk-live-$(whoami) "quoted"')

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('security')
    expect(calls[0]).toContain('add-generic-password')
    expect(calls[0]).toContain('bond-mcp:remote-token')
    // Verbatim — no escaping, no wrapping quotes, no shell in the path.
    expect(calls[0]).toContain('sk-live-$(whoami) "quoted"')
  })

  it('updates in place rather than duplicating the item', async () => {
    await keychainStore.set('token', 'value')
    expect(calls[0]).toContain('-U')
  })

  it('reads a secret back and strips the trailing newline the CLI adds', async () => {
    succeed('sk-live-123\n')
    await expect(keychainStore.get('token')).resolves.toBe('sk-live-123')
  })

  it('returns null rather than throwing when an item is absent', async () => {
    fail()
    await expect(keychainStore.get('missing')).resolves.toBeNull()
  })

  it('reports a refused write with the keychain message', async () => {
    fail('User interaction is not allowed.')
    await expect(keychainStore.set('token', 'value')).rejects.toThrow(/User interaction is not allowed/)
  })

  it('reports removal success by exit status', async () => {
    await expect(keychainStore.remove('token')).resolves.toBe(true)
    fail()
    await expect(keychainStore.remove('token')).resolves.toBe(false)
  })

  it('lists only Bond MCP items from a keychain dump', async () => {
    succeed([
      '"svce"<blob>="bond-mcp:remote-token"',
      '"svce"<blob>="com.apple.something"',
      '"svce"<blob>="bond-mcp:other"',
      '"svce"<blob>="bond-mcp:remote-token"',
    ].join('\n'))
    await expect(keychainStore.list()).resolves.toEqual(['other', 'remote-token'])
  })

  it('rejects a ref that could confuse the security CLI', async () => {
    await expect(keychainStore.set('has space', 'x')).rejects.toBeInstanceOf(KeychainError)
    await expect(keychainStore.set('-flagish', 'x')).rejects.toThrow(/not a usable secret name/)
    await expect(keychainStore.get('bad ref')).rejects.toBeInstanceOf(KeychainError)
    expect(calls).toHaveLength(0)
  })
})
