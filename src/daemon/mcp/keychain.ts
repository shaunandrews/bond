/**
 * macOS Keychain storage for MCP credentials.
 *
 * The config row (`mcp.servers`) NEVER holds a secret. It holds a reference —
 * `keychain:<ref>` — anywhere a header value or env value would otherwise be
 * a token, and this module resolves those references at connect time only.
 * Nothing here is ever returned over RPC or written to a log.
 */

import { execFile } from 'node:child_process'

/** Keychain "service" prefix, so Bond's items are identifiable in Keychain Access. */
const SERVICE_PREFIX = 'bond-mcp'
const ACCOUNT = 'bond'
const PREFIX = 'keychain:'

export const SECRET_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export class KeychainError extends Error {}

export interface SecretStore {
  set(ref: string, value: string): Promise<void>
  get(ref: string): Promise<string | null>
  remove(ref: string): Promise<boolean>
  list(): Promise<string[]>
}

export interface SecurityResult { code: number; stdout: string; stderr: string }
export type RunSecurity = (args: string[]) => Promise<SecurityResult>

/**
 * The real `security` runner. Injected rather than imported directly so a
 * test can never reach the user's actual login keychain — mocking
 * node:child_process is one silent misconfiguration away from writing real
 * items, which is exactly what happened once.
 */
export const runSecurity: RunSecurity = (args) => new Promise((resolve) => {
  // execFile, never a shell: a secret must not pass through shell parsing.
  execFile('security', args, { encoding: 'utf-8' }, (error, stdout, stderr) => {
    const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
    resolve({ code, stdout, stderr })
  })
})

function serviceFor(ref: string): string {
  return `${SERVICE_PREFIX}:${ref}`
}

function assertRef(ref: string): void {
  if (!SECRET_REF_RE.test(ref)) {
    throw new KeychainError(`"${ref}" is not a usable secret name (letters, digits, dot, dash, underscore).`)
  }
}

/**
 * The real macOS Keychain via the `security` CLI.
 *
 * The secret rides in argv on `set`. On macOS a user can already read their
 * own process list, and the alternative (`security` with no -w) is an
 * interactive prompt no daemon can answer — so this is the practical floor,
 * and it is why the value never touches a shell or a log.
 */
export function createKeychainStore(run: RunSecurity): SecretStore {
  return {
    async set(ref, value) {
      assertRef(ref)
      const result = await run(['add-generic-password', '-a', ACCOUNT, '-s', serviceFor(ref), '-w', value, '-U'])
      if (result.code !== 0) throw new KeychainError(`Keychain refused to store "${ref}": ${result.stderr.trim() || `exit ${result.code}`}`)
    },

    async get(ref) {
      assertRef(ref)
      const result = await run(['find-generic-password', '-a', ACCOUNT, '-s', serviceFor(ref), '-w'])
      if (result.code !== 0) return null
      // `security -w` appends a newline; a trailing newline is never part of a token.
      return result.stdout.replace(/\n$/, '')
    },

    async remove(ref) {
      assertRef(ref)
      const result = await run(['delete-generic-password', '-a', ACCOUNT, '-s', serviceFor(ref)])
      return result.code === 0
    },

    async list() {
      const result = await run(['dump-keychain'])
      if (result.code !== 0) return []
      const refs = new Set<string>()
      for (const match of result.stdout.matchAll(new RegExp(`"svce"<blob>="${SERVICE_PREFIX}:([^"]+)"`, 'g'))) {
        refs.add(match[1])
      }
      return [...refs].sort()
    },
  }
}

export const keychainStore: SecretStore = createKeychainStore(runSecurity)

let store: SecretStore = keychainStore

/** Swap the backing store (tests, and any future non-macOS port). */
export function setSecretStore(next: SecretStore): void {
  store = next
}

export function getSecretStore(): SecretStore {
  return store
}

/**
 * References are matched ANYWHERE in a value, not just at the start: the
 * common case is a header written as `Bearer keychain:my-token`. An
 * only-at-the-start check silently shipped that literal string as the
 * Authorization header instead of the token.
 */
const REF_IN_VALUE_RE = /keychain:([a-z0-9][a-z0-9._-]*)/gi

export function hasSecretRef(value: string): boolean {
  return refsInValue(value).length > 0
}

/** Every ref mentioned in one value, in order of appearance, deduped. */
export function refsInValue(value: string): string[] {
  return [...new Set([...value.matchAll(REF_IN_VALUE_RE)].map((match) => match[1]))]
}

export function toSecretRef(ref: string): string {
  return `${PREFIX}${ref}`
}

export function setSecret(ref: string, value: string): Promise<void> {
  return store.set(ref, value)
}

export function removeSecret(ref: string): Promise<boolean> {
  return store.remove(ref)
}

export function listSecretRefs(): Promise<string[]> {
  return store.list()
}

/**
 * Replace every `keychain:<ref>` in a header/env map with its stored secret.
 * A missing secret is a hard error — silently sending an unauthenticated
 * request produces a confusing 401 instead of "your token is gone".
 */
export async function resolveSecrets(values: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
  if (!values) return undefined
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    let next = value
    for (const ref of refsInValue(value)) {
      const secret = await store.get(ref)
      if (secret === null) {
        throw new KeychainError(`No Keychain secret called "${ref}" — set it again in Settings → MCP connections.`)
      }
      next = next.replaceAll(toSecretRef(ref), secret)
    }
    resolved[key] = next
  }
  return resolved
}

/** Every secret ref a value map points at (for UI badges — never the values). */
export function secretRefsIn(values: Record<string, string> | undefined): string[] {
  if (!values) return []
  return [...new Set(Object.values(values).flatMap(refsInValue))]
}
