import { isAbsolute, normalize, sep } from 'node:path'

export const MATHIS_COMMAND_POLICY_VERSION = 'mathis-local-argv-v1'

export type CommandPolicyDecision =
  | { kind: 'allow'; rule: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'question'; reason: string; proposedAllowlistAddition: string }

const DENIED_EXECUTABLES = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'osascript',
  'gh', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync',
  'open', 'electron', 'launchctl', 'systemctl', 'sudo', 'su',
  'kill', 'pkill', 'killall', 'xargs', 'env',
])

const REMOTE_GIT = new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'ls-remote', 'submodule'])
const WORKTREE_GIT = new Set(['worktree'])
const LOCAL_GIT = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'add', 'commit', 'branch',
  'restore', 'reset', 'grep', 'blame', 'ls-files', 'check-ignore', 'merge-base',
])
const NPM_RUN_SCRIPTS = new Set([
  'test', 'test:run', 'test:coverage', 'typecheck',
  'build', 'build:web', 'build:daemon', 'build:cli', 'build:native',
  'design-system:generate', 'design-system:check',
])
const DENIED_NPM_SCRIPTS = new Set(['dev', 'start', 'stop', 'restart', 'preview', 'pack', 'dist'])
const LOCAL_NPX_TOOLS = new Set(['vitest', 'vue-tsc', 'tsc', 'vite', 'eslint'])

function executableName(value: string): string {
  return value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase()
}

function pathEscape(argv: string[]): string | null {
  for (const value of argv) {
    if (value.includes('\0')) return 'Command arguments may not contain NUL bytes.'
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /(^|=)\//.test(value)) return `Absolute paths are not allowed in agent commands: ${value}`
    const normalized = normalize(value)
    if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`) || /(^|[=,:])\.\.([/\\]|$)/.test(value)) {
      return `Worktree-relative path escape is not allowed: ${value}`
    }
  }
  return null
}

export function exactCommandGrant(argv: string[]): string {
  return JSON.stringify(argv)
}

export function applyRepositoryCommandProfile(
  argv: string[],
  decision: CommandPolicyDecision,
  rules: readonly string[] | undefined,
): CommandPolicyDecision {
  if (decision.kind !== 'allow' || !rules || rules.includes('*') || decision.rule === 'run-scoped exact grant' || rules.includes(decision.rule)) return decision
  return question(argv, `The registered repository profile does not allow "${decision.rule}".`)
}

export function evaluateMathisCommand(argv: string[], exactGrants: ReadonlySet<string> = new Set()): CommandPolicyDecision {
  if (!argv.length || !argv[0]?.trim()) return { kind: 'deny', reason: 'A command must contain an executable.' }
  if (argv.length > 128) return { kind: 'deny', reason: 'Command argv exceeds the 128-argument cap.' }
  if (argv[0].includes('/') || argv[0].includes('\\')) return { kind: 'deny', reason: 'Executables must be resolved from the runner\'s explicit PATH.' }

  const escape = pathEscape(argv.slice(1))
  if (escape) return { kind: 'deny', reason: escape }

  const executable = executableName(argv[0])
  if (DENIED_EXECUTABLES.has(executable)) return { kind: 'deny', reason: `${executable} is hard-denied for managed agent runs.` }
  if (executable === 'node' && argv.slice(1).some(value => ['-e', '--eval', '-p', '--print'].includes(value))) {
    return { kind: 'deny', reason: 'Inline Node programs are hard-denied; run a repository script by path.' }
  }

  if (executable === 'git') {
    if (argv.some(value => value === '-C' || value === '-c' || value.startsWith('--config-env') || value.startsWith('--git-dir') || value.startsWith('--work-tree'))) {
      return { kind: 'deny', reason: 'Git repository/worktree overrides are hard-denied.' }
    }
    const verb = argv.slice(1).find(value => !value.startsWith('-'))?.toLowerCase()
    if (!verb) return question(argv, 'No allowlisted git subcommand was provided.')
    if (REMOTE_GIT.has(verb)) return { kind: 'deny', reason: `git ${verb} can access or modify remotes and is hard-denied.` }
    if (WORKTREE_GIT.has(verb)) return { kind: 'deny', reason: 'Agent runs may not create or alter git worktrees.' }
    if (exactGrants.has(exactCommandGrant(argv))) return { kind: 'allow', rule: 'run-scoped exact grant' }
    if (LOCAL_GIT.has(verb)) return { kind: 'allow', rule: `git ${verb}` }
    return question(argv, `git ${verb} is not in the local command allowlist.`)
  }

  if (executable === 'npm') {
    const action = argv[1]?.toLowerCase()
    if (action === 'install' || action === 'ci') return { kind: 'allow', rule: `npm ${action} (scripts disabled by runner)` }
    if (action === 'test') return { kind: 'allow', rule: 'npm test' }
    if (action === 'run') {
      const script = argv[2]?.toLowerCase()
      if (script && DENIED_NPM_SCRIPTS.has(script)) return { kind: 'deny', reason: `npm run ${script} launches or packages the app and is hard-denied.` }
      if (script && NPM_RUN_SCRIPTS.has(script)) return { kind: 'allow', rule: `npm run ${script}` }
    }
    if (exactGrants.has(exactCommandGrant(argv))) return { kind: 'allow', rule: 'run-scoped exact grant' }
    return question(argv, 'This npm action is not in the Bond development allowlist.')
  }

  if (executable === 'npx') {
    const toolIndex = argv[1] === '--no-install' ? 2 : -1
    if (toolIndex < 0) return { kind: 'deny', reason: 'npx requires --no-install so an agent cannot download executables.' }
    const tool = executableName(argv[toolIndex] ?? '')
    if (LOCAL_NPX_TOOLS.has(tool)) return { kind: 'allow', rule: `npx --no-install ${tool}` }
    if (exactGrants.has(exactCommandGrant(argv))) return { kind: 'allow', rule: 'run-scoped exact grant' }
    return question(argv, `npx tool ${tool || '(missing)'} is not allowlisted.`)
  }

  if (exactGrants.has(exactCommandGrant(argv))) return { kind: 'allow', rule: 'run-scoped exact grant' }
  return question(argv, `${executable} is not in the managed command allowlist.`)
}

function question(argv: string[], reason: string): CommandPolicyDecision {
  return {
    kind: 'question',
    reason,
    proposedAllowlistAddition: `Allow this exact argv for this run only: ${exactCommandGrant(argv)}`,
  }
}
