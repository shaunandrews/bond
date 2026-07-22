import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { dispatchAgentRun } from './service'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bond-agent-service-'))
  setDataDir(dir)
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
  setDataDir(null as never)
})

describe('async agent dispatch service', () => {
  it('persists a read-only contract and returns the same row for a retry', async () => {
    const input = {
      agent: 'felix',
      verb: 'define',
      brief: 'Describe the existing system without changing it.',
      paths: [],
      idempotencyKey: 'confirmed-brief-1',
      parentModel: 'balanced',
    }
    const first = await dispatchAgentRun(input)
    const retry = await dispatchAgentRun(input)

    expect(first.created).toBe(true)
    expect(first.run).toMatchObject({ status: 'queued', workspace: { readOnly: true, isolation: 'in-place' } })
    expect(retry).toMatchObject({ created: false, run: { id: first.run.id } })
  })

  it('rejects reuse of an idempotency key for a different brief', async () => {
    await dispatchAgentRun({ agent: 'felix', verb: 'define', brief: 'one', idempotencyKey: 'collision' })
    await expect(dispatchAgentRun({ agent: 'felix', verb: 'define', brief: 'two', idempotencyKey: 'collision' }))
      .rejects.toThrow('different agent run')
  })
})
