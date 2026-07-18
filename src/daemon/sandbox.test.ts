import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setDataDir, getDataDir } from './paths'
import { closeDb, getDb } from './db'
import { enterSandbox, exitSandbox, isSandboxed, sandboxDirPath } from './sandbox'
import { getFirstRunStatus } from './onboarding'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `bond-test-sandbox-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
})

afterEach(() => {
  if (isSandboxed()) exitSandbox()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

function insertMessage(id: string, text: string): void {
  getDb().prepare('INSERT INTO messages (id, role, text, seq) VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages))').run(id, 'user', text)
}

function messageCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
}

describe('new-user sandbox', () => {
  it('swaps to an empty data directory and back', () => {
    insertMessage('real-1', 'real data')
    expect(isSandboxed()).toBe(false)

    const { dataDir } = enterSandbox()

    expect(isSandboxed()).toBe(true)
    expect(getDataDir()).toBe(dataDir)
    expect(dataDir).toBe(sandboxDirPath(testDir))
    expect(messageCount()).toBe(0)

    exitSandbox()

    expect(isSandboxed()).toBe(false)
    expect(getDataDir()).toBe(testDir)
    expect(messageCount()).toBe(1)
  })

  it('keeps sandbox writes out of the real database and wipes them on exit', () => {
    insertMessage('real-1', 'real data')
    enterSandbox()
    insertMessage('sandbox-1', 'sandbox only')
    expect(messageCount()).toBe(1)

    exitSandbox()

    expect(messageCount()).toBe(1)
    expect(getDb().prepare("SELECT id FROM messages WHERE id = 'sandbox-1'").get()).toBeUndefined()
    expect(existsSync(sandboxDirPath(testDir))).toBe(false)
  })

  it('looks like a genuine first run inside the sandbox', () => {
    insertMessage('real-1', 'real data')
    // Real install has data → existing-user
    expect(getFirstRunStatus().status).toBe('existing-user')

    enterSandbox()
    expect(getFirstRunStatus().status).toBe('pending')
    exitSandbox()

    // Real state untouched by the sandbox's onboarding state
    expect(getFirstRunStatus().status).toBe('existing-user')
  })

  it('starts fresh on every enter', () => {
    enterSandbox()
    insertMessage('sandbox-1', 'from first run-through')
    exitSandbox()

    enterSandbox()
    expect(messageCount()).toBe(0)
  })

  it('rejects double enter and unbalanced exit', () => {
    enterSandbox()
    expect(() => enterSandbox()).toThrow(/Already/)
    exitSandbox()
    expect(() => exitSandbox()).toThrow(/Not in/)
  })
})
