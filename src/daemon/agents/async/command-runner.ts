import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import type { AgentRunResourceCaps } from '../../../shared/agent-runs'

export interface ArgvCommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated: boolean
}

export interface ArgvCommandRunnerOptions {
  cwd: string
  signal?: AbortSignal
  caps: AgentRunResourceCaps
  path?: string
  onProcess?: (pid: number | null) => void
}

export class CommandOutputLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Command output exceeded the ${limit}-character cap.`)
    this.name = 'CommandOutputLimitError'
  }
}

function terminateGroup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return
    try { process.kill(-child.pid!, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  }, 1_000)
  timer.unref()
}

export function runArgvCommand(argv: string[], options: ArgvCommandRunnerOptions): Promise<ArgvCommandResult> {
  if (!argv.length) return Promise.reject(new Error('Command argv is empty.'))
  const outputCap = Math.max(1, options.caps.maxOutputChars)
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: options.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: homedir(),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        CI: '1',
        NO_COLOR: '1',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    options.onProcess?.(child.pid ?? null)
    let stdout = ''
    let stderr = ''
    let size = 0
    let exceeded = false
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      terminateGroup(child)
    }, Math.max(1, options.caps.wallClockSeconds) * 1000)
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (exceeded) return
      const text = chunk.toString('utf8')
      const remaining = outputCap - size
      if (text.length > remaining) {
        exceeded = true
        if (remaining > 0) target === 'stdout' ? stdout += text.slice(0, remaining) : stderr += text.slice(0, remaining)
        terminateGroup(child)
        return
      }
      size += text.length
      target === 'stdout' ? stdout += text : stderr += text
    }
    child.stdout?.on('data', chunk => append('stdout', chunk))
    child.stderr?.on('data', chunk => append('stderr', chunk))
    const abort = () => terminateGroup(child)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.once('error', error => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      options.onProcess?.(null)
      if (exceeded) return reject(new CommandOutputLimitError(outputCap))
      if (timedOut) return reject(new Error(`Command exceeded the ${options.caps.wallClockSeconds}s wall-clock cap.`))
      if (options.signal?.aborted) return reject(new Error('Command cancelled.'))
      resolve({ exitCode, signal, stdout, stderr, truncated: false })
    })
  })
}
