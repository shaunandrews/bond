import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import type { AgentRepositorySnapshot, RegisteredAgentRepository } from '../../../shared/agent-runs'
import { getDb } from '../../db'
import { SECRET_REF_RE } from '../../mcp/keychain'
import { getSetting } from '../../settings'
import { SAFE_COMMAND_PATH } from './command-runner'
import { applyRepositoryCommandProfile, evaluateMathisCommand } from './command-policy'
import { ensureAgentRunSchema } from './schema'
import { configuredBondBaseRef, configuredBondRepoRoot } from './workspace'

const execFileAsync = promisify(execFile)
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const REF_RE = /^[A-Za-z0-9._/-]+$/
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

type Row = {
  id: string; label: string; repo_root: string; base_ref: string; allowed_path_prefixes_json: string
  github_repository: string | null; remote: string | null; expected_remote_url: string | null; credential_ref: string | null
  command_rules_json: string; acceptance_checks_json: string; trusted_in_place: number; built_in: number; created_at: string; updated_at: string
}

export interface RegisterAgentRepositoryInput {
  id: string
  label: string
  repoRoot: string
  baseRef: string
  allowedPathPrefixes: string[]
  githubRepository?: string | null
  remote?: string | null
  expectedRemoteUrl?: string | null
  credentialRef?: string | null
  commandRules: string[]
  acceptanceChecks: string[]
  trustedInPlace?: boolean
  confirmed: boolean
}

function dbFor(db?: Database.Database): Database.Database {
  const value = db ?? getDb()
  ensureAgentRunSchema(value)
  return value
}

function rowToRepository(row: Row): RegisteredAgentRepository {
  return {
    id: row.id, label: row.label, repoRoot: row.repo_root, baseRef: row.base_ref,
    allowedPathPrefixes: JSON.parse(row.allowed_path_prefixes_json), githubRepository: row.github_repository,
    remote: row.remote, expectedRemoteUrl: row.expected_remote_url, credentialRef: row.credential_ref,
    commandRules: JSON.parse(row.command_rules_json), acceptanceChecks: JSON.parse(row.acceptance_checks_json),
    trustedInPlace: row.trusted_in_place === 1, builtIn: row.built_in === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function normalizedPrefixes(values: string[]): string[] {
  if (!values.length) throw new Error('At least one allowed path prefix is required.')
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Allowed path prefixes must be non-empty relative paths.')
    const path = normalize(value.trim())
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`Allowed path prefix escapes the repository: ${value}`)
    return path === '' ? '.' : path
  }))].sort()
}

function validateChecks(values: string[]): string[] {
  return values.map(value => {
    let argv: unknown
    try { argv = JSON.parse(value) } catch { throw new Error(`Acceptance check is not argv JSON: ${value}`) }
    if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string' || item.includes('\0'))) throw new Error('Acceptance checks must be non-empty string argv arrays.')
    return JSON.stringify(argv)
  })
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    env: { PATH: SAFE_COMMAND_PATH, HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000, maxBuffer: 256 * 1024,
  })
  return result.stdout.trim()
}

function githubRemoteUrls(repository: string): Set<string> {
  return new Set([`https://github.com/${repository}.git`, `git@github.com:${repository}.git`])
}

export async function registerAgentRepository(input: RegisterAgentRepositoryInput, dbArg?: Database.Database): Promise<RegisteredAgentRepository> {
  if (!input.confirmed) throw new Error('Repository registration requires explicit user confirmation.')
  const id = input.id.trim().toLowerCase()
  if (!ID_RE.test(id) || id === 'bond') throw new Error('Repository id must be a safe unique slug; "bond" is reserved.')
  const label = input.label.trim()
  if (!label || label.length > 100) throw new Error('Repository label must be 1-100 characters.')
  if (!REF_RE.test(input.baseRef)) throw new Error('Base branch is invalid.')
  const root = realpathSync(resolve(input.repoRoot))
  if (!statSync(root).isDirectory()) throw new Error('Repository root must be a directory.')
  if (realpathSync(await git(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error('Repository root must be the exact git top-level directory.')
  await git(root, ['rev-parse', '--verify', `${input.baseRef}^{commit}`])
  const prefixes = normalizedPrefixes(input.allowedPathPrefixes)
  const rules = [...new Set(input.commandRules.map(value => value.trim()).filter(Boolean))].sort()
  if (!rules.length) throw new Error('At least one command policy rule is required.')
  const checks = validateChecks(input.acceptanceChecks)
  for (const check of checks) {
    const argv = JSON.parse(check) as string[]
    const decision = applyRepositoryCommandProfile(argv, evaluateMathisCommand(argv), rules)
    if (decision.kind !== 'allow') throw new Error(`Acceptance check is not allowed by the repository command profile: ${check}`)
  }

  const githubRepository = input.githubRepository?.trim() || null
  const remote = input.remote?.trim() || null
  const expectedRemoteUrl = input.expectedRemoteUrl?.trim() || null
  const credentialRef = input.credentialRef?.trim() || null
  if ([githubRepository, remote, expectedRemoteUrl, credentialRef].some(Boolean) && ![githubRepository, remote, expectedRemoteUrl, credentialRef].every(Boolean)) {
    throw new Error('GitHub repository, remote, expected URL, and credential reference must be configured together.')
  }
  if (githubRepository) {
    if (!REPOSITORY_RE.test(githubRepository)) throw new Error('GitHub repository must be owner/name.')
    if (!/^[A-Za-z0-9._-]+$/.test(remote!)) throw new Error('Git remote name is invalid.')
    if (!SECRET_REF_RE.test(credentialRef!)) throw new Error('Credential reference is invalid.')
    if (!githubRemoteUrls(githubRepository).has(expectedRemoteUrl!)) throw new Error('Expected remote URL does not match the GitHub repository identity.')
    const actual = await git(root, ['remote', 'get-url', remote!])
    if (actual !== expectedRemoteUrl) throw new Error(`Registered remote URL mismatch: expected ${expectedRemoteUrl}, found ${actual}.`)
  }

  const db = dbFor(dbArg)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO agent_repositories (
    id, label, repo_root, base_ref, allowed_path_prefixes_json, github_repository, remote,
    expected_remote_url, credential_ref, command_rules_json, acceptance_checks_json,
    trusted_in_place, built_in, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label, repo_root=excluded.repo_root, base_ref=excluded.base_ref,
    allowed_path_prefixes_json=excluded.allowed_path_prefixes_json, github_repository=excluded.github_repository,
    remote=excluded.remote, expected_remote_url=excluded.expected_remote_url, credential_ref=excluded.credential_ref,
    command_rules_json=excluded.command_rules_json, acceptance_checks_json=excluded.acceptance_checks_json,
    trusted_in_place=excluded.trusted_in_place, updated_at=excluded.updated_at
  WHERE agent_repositories.built_in = 0`)
    .run(id, label, root, input.baseRef, JSON.stringify(prefixes), githubRepository, remote, expectedRemoteUrl,
      credentialRef, JSON.stringify(rules), JSON.stringify(checks), input.trustedInPlace ? 1 : 0, now, now)
  return getAgentRepository(id, db)!
}

function builtInBond(): RegisteredAgentRepository {
  const now = new Date(0).toISOString()
  return {
    id: 'bond', label: 'Bond', repoRoot: configuredBondRepoRoot(), baseRef: configuredBondBaseRef(),
    allowedPathPrefixes: ['.'], githubRepository: 'shaunandrews/bond', remote: 'origin',
    expectedRemoteUrl: 'https://github.com/shaunandrews/bond.git', credentialRef: getSetting('agents.github.credentialRef') ?? 'github-bond-agent',
    commandRules: ['*'], acceptanceChecks: [JSON.stringify(['npm', 'run', 'typecheck']), JSON.stringify(['npm', 'run', 'test:run']), JSON.stringify(['npm', 'run', 'build'])],
    trustedInPlace: false, builtIn: true, createdAt: now, updatedAt: now,
  }
}

export function getAgentRepository(id: string, dbArg?: Database.Database): RegisteredAgentRepository | null {
  if (id === 'bond') return builtInBond()
  const row = dbFor(dbArg).prepare('SELECT * FROM agent_repositories WHERE id = ?').get(id) as Row | undefined
  return row ? rowToRepository(row) : null
}

export function listAgentRepositories(dbArg?: Database.Database): RegisteredAgentRepository[] {
  const rows = dbFor(dbArg).prepare('SELECT * FROM agent_repositories ORDER BY label COLLATE NOCASE').all() as Row[]
  return [builtInBond(), ...rows.map(rowToRepository)]
}

export function removeAgentRepository(id: string, dbArg?: Database.Database): boolean {
  if (id === 'bond') throw new Error('The built-in Bond repository cannot be removed.')
  return dbFor(dbArg).prepare('DELETE FROM agent_repositories WHERE id = ? AND built_in = 0').run(id).changes === 1
}

export function snapshotAgentRepository(repo: RegisteredAgentRepository): AgentRepositorySnapshot {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...snapshot } = repo
  return snapshot
}

export function assertRepositoryRelativePath(repo: Pick<RegisteredAgentRepository, 'repoRoot' | 'allowedPathPrefixes'>, target: string): string {
  const absolute = resolve(repo.repoRoot, target)
  const rel = relative(repo.repoRoot, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path is outside registered repository: ${target}`)
  const allowed = repo.allowedPathPrefixes.some(prefix => prefix === '.' || rel === prefix || rel.startsWith(`${prefix}${sep}`))
  if (!allowed) throw new Error(`Path is outside registered allowed paths: ${target}`)
  return absolute
}

export async function inspectInPlaceRepository(repo: RegisteredAgentRepository): Promise<{ branch: string; porcelain: string }> {
  const [branch, porcelain] = await Promise.all([git(repo.repoRoot, ['branch', '--show-current']), git(repo.repoRoot, ['status', '--porcelain=v1'])])
  return { branch, porcelain }
}
