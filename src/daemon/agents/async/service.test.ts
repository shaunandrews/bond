import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { setSetting } from '../../settings'
import { dispatchAgentRun } from './service'
import { registerAgentRepository } from './repository-registry'

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
  async function registeredRepo(trustedInPlace = false): Promise<string> {
    const repo = join(dir, 'studio')
    mkdirSync(join(repo, 'src'), { recursive: true })
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } })
    git(['init', '-b', 'main'])
    writeFileSync(join(repo, 'src', 'index.ts'), 'export {}\n')
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test:run":"vitest run"}}\n')
    git(['add', '.'])
    git(['-c', 'user.name=Bond Tests', '-c', 'user.email=bond@example.test', 'commit', '-m', 'base'])
    await registerAgentRepository({
      id: 'studio', label: 'Studio', repoRoot: repo, baseRef: 'main', allowedPathPrefixes: ['src'],
      commandRules: ['git status'], acceptanceChecks: [], trustedInPlace, confirmed: true,
    })
    return repo
  }
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
    expect(first.run).toMatchObject({
      status: 'queued', workspace: { readOnly: true, isolation: 'in-place' },
      settings: { budgetPreset: 'standard' }, resourceCaps: { budgetPreset: 'standard', maxSteps: 80 },
    })
    expect(retry).toMatchObject({ created: false, run: { id: first.run.id } })
  })

  it('rejects reuse of an idempotency key for a different brief', async () => {
    await dispatchAgentRun({ agent: 'felix', verb: 'define', brief: 'one', idempotencyKey: 'collision' })
    await expect(dispatchAgentRun({ agent: 'felix', verb: 'define', brief: 'two', idempotencyKey: 'collision' }))
      .rejects.toThrow('different agent run')
  })

  it('requires explicit immutable-brief confirmation before dispatching Mathis', async () => {
    setSetting('agents.bondRepoRoot', process.cwd())
    setSetting('agents.bondBaseRef', 'main')
    const input = { agent: 'mathis', verb: 'build', brief: 'Implement the confirmed local change.', idempotencyKey: 'mathis-confirmed' }
    await expect(dispatchAgentRun(input)).rejects.toThrow('explicit user confirmation')
    const dispatched = await dispatchAgentRun({ ...input, confirmed: true })
    expect(dispatched.run).toMatchObject({
      agent: 'mathis',
      brief: input.brief,
      workspace: { isolation: 'worktree', readOnly: false, repoRoot: process.cwd() },
      workspaceState: { status: 'pending' },
    })
    await expect(dispatchAgentRun(input)).rejects.toThrow('explicit user confirmation')
    expect((await dispatchAgentRun({ ...input, confirmed: true })).run.id).toBe(dispatched.run.id)
  })

  it('requires confirmed repo selection, confines paths, and gives concurrent runs unique worktrees', async () => {
    const repo = await registeredRepo()
    const base = { agent: 'mathis', verb: 'build', brief: 'Change Studio.', confirmed: true, repositoryId: 'studio', paths: ['src'] }
    await expect(dispatchAgentRun({ ...base, idempotencyKey: 'studio-unconfirmed' })).rejects.toThrow('target selection')
    await expect(dispatchAgentRun({ ...base, targetConfirmed: true, paths: ['package.json'], idempotencyKey: 'studio-escape' })).rejects.toThrow('allowed paths')
    const first = await dispatchAgentRun({ ...base, targetConfirmed: true, idempotencyKey: 'studio-1' })
    const second = await dispatchAgentRun({ ...base, targetConfirmed: true, idempotencyKey: 'studio-2' })
    expect(first.run.repository).toMatchObject({ id: 'studio', repoRoot: realpathSync(repo), commandRules: ['git status'] })
    expect(first.run.workspace).toMatchObject({ repositoryId: 'studio', isolation: 'worktree' })
    if (first.run.workspace.isolation !== 'worktree' || second.run.workspace.isolation !== 'worktree') throw new Error('expected worktrees')
    expect(first.run.workspace.worktreePath).not.toBe(second.run.workspace.worktreePath)
    expect(first.run.allowedPaths[0]).toContain('/src')
  })

  it('gates every trusted in-place dispatch and refuses a dirty checkout', async () => {
    const repo = await registeredRepo(true)
    const input = { agent: 'mathis', verb: 'build', brief: 'Trusted local edit.', confirmed: true, repositoryId: 'studio', targetConfirmed: true, isolation: 'in-place' as const }
    await expect(dispatchAgentRun({ ...input, idempotencyKey: 'in-place-unconfirmed' })).rejects.toThrow('extra per-run confirmation')
    writeFileSync(join(repo, 'src', 'dirty.ts'), 'dirty\n')
    await expect(dispatchAgentRun({ ...input, inPlaceConfirmed: true, idempotencyKey: 'in-place-dirty' })).rejects.toThrow('clean')
    rmSync(join(repo, 'src', 'dirty.ts'))
    const dispatched = await dispatchAgentRun({ ...input, inPlaceConfirmed: true, idempotencyKey: 'in-place-clean' })
    expect(dispatched.run.workspace).toMatchObject({ repositoryId: 'studio', isolation: 'in-place', readOnly: false, branch: 'main' })
  })
})
