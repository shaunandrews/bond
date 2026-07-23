import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../db'
import { setDataDir } from '../../paths'
import { assertRepositoryRelativePath, getAgentRepository, listAgentRepositories, registerAgentRepository, removeAgentRepository } from './repository-registry'

let dir: string
let repo: string

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bond-repository-registry-'))
  repo = join(dir, 'studio')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(['init', '-b', 'main'])
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {}\n')
  git(['add', '.'])
  git(['-c', 'user.name=Bond Tests', '-c', 'user.email=bond@example.test', 'commit', '-m', 'base'])
  git(['remote', 'add', 'origin', 'https://github.com/example/studio.git'])
  mkdirSync(join(dir, 'data'), { recursive: true })
  setDataDir(join(dir, 'data'))
  getDb()
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
  setDataDir(null as never)
})

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'studio', label: 'Studio', repoRoot: repo, baseRef: 'main', allowedPathPrefixes: ['src'],
    githubRepository: 'example/studio', remote: 'origin', expectedRemoteUrl: 'https://github.com/example/studio.git',
    credentialRef: 'github-studio-agent', commandRules: ['git status', 'npm run test:run'],
    acceptanceChecks: [JSON.stringify(['npm', 'run', 'test:run'])], trustedInPlace: false, confirmed: true,
    ...overrides,
  }
}

describe('registered agent repositories', () => {
  it('persists a canonical identity and snapshots repo-scoped policy without credentials', async () => {
    const value = await registerAgentRepository(registration())
    expect(value).toMatchObject({ id: 'studio', repoRoot: realpathSync(repo), baseRef: 'main', remote: 'origin', credentialRef: 'github-studio-agent', builtIn: false })
    expect(getAgentRepository('studio')).toEqual(value)
    expect(listAgentRepositories().map(item => item.id)).toContain('bond')
    expect(JSON.stringify(value)).not.toContain('token')
  })

  it('requires confirmation and rejects invalid identities, escapes, and wrong remotes', async () => {
    await expect(registerAgentRepository(registration({ confirmed: false }))).rejects.toThrow('confirmation')
    await expect(registerAgentRepository(registration({ id: '../studio' }))).rejects.toThrow('safe unique slug')
    await expect(registerAgentRepository(registration({ allowedPathPrefixes: ['../outside'] }))).rejects.toThrow('escapes')
    await expect(registerAgentRepository(registration({ acceptanceChecks: [JSON.stringify(['git', 'push'])] }))).rejects.toThrow('not allowed')
    await expect(registerAgentRepository(registration({ expectedRemoteUrl: 'https://github.com/example/other.git' }))).rejects.toThrow('does not match')
    git(['remote', 'set-url', 'origin', 'https://github.com/example/other.git'])
    await expect(registerAgentRepository(registration())).rejects.toThrow('remote URL mismatch')
  })

  it('prevents cross-repo and out-of-profile paths and supports explicit cleanup', async () => {
    const value = await registerAgentRepository(registration())
    expect(assertRepositoryRelativePath(value, 'src/index.ts')).toBe(join(realpathSync(repo), 'src', 'index.ts'))
    expect(() => assertRepositoryRelativePath(value, 'package.json')).toThrow('allowed paths')
    expect(() => assertRepositoryRelativePath(value, '../other/file')).toThrow('outside registered repository')
    expect(removeAgentRepository('studio')).toBe(true)
    expect(getAgentRepository('studio')).toBeNull()
    expect(() => removeAgentRepository('bond')).toThrow('cannot be removed')
  })
})
