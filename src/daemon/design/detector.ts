/**
 * Wrapper around Impeccable's standalone deterministic detector
 * (`npx impeccable detect --json`) — 46 anti-slop/quality/drift rules, no AI,
 * no API keys. Version-pinned so findings stay reproducible. The detector is
 * an optional evidence source: offline, missing npx, or a timeout degrade to
 * a status Felix reports honestly instead of failing the consultation.
 */

import { spawn } from 'node:child_process'

export const IMPECCABLE_VERSION = '3.9.1'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_FINDINGS = 200
const MAX_OUTPUT_CHARS = 512 * 1024

export type DetectorOutcome =
  | { status: 'ok'; findings: unknown[]; truncated: boolean }
  | { status: 'unavailable' | 'timeout' | 'error'; message: string }

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ExecFn = (command: string, args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<ExecResult>

export interface DetectorOptions {
  cwd?: string
  timeoutMs?: number
  /** Injection point for tests; defaults to a child_process spawn wrapper. */
  exec?: ExecFn
}

const spawnExec: ExecFn = (command, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
  })

/**
 * Linter convention: a nonzero exit with findings is success, so parse stdout
 * before judging the exit code. Accepts a bare array, or an object carrying a
 * findings/results/issues array.
 */
export function parseDetectorOutput(stdout: string): unknown[] | undefined {
  const start = stdout.search(/[[{]/)
  if (start === -1) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start))
  } catch {
    return undefined
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['findings', 'results', 'issues']) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
  }
  return undefined
}

export async function runImpeccableDetect(paths: string[], options: DetectorOptions = {}): Promise<DetectorOutcome> {
  if (!paths.length) return { status: 'error', message: 'No paths to scan.' }
  const exec = options.exec ?? spawnExec
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let result: ExecResult
  try {
    result = await exec('npx', ['-y', `impeccable@${IMPECCABLE_VERSION}`, 'detect', '--json', ...paths], {
      cwd: options.cwd,
      timeoutMs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'unavailable', message: `Detector could not run (${message}).` }
  }

  if (result.timedOut) {
    return { status: 'timeout', message: `Detector timed out after ${Math.round(timeoutMs / 1000)}s.` }
  }
  const findings = parseDetectorOutput(result.stdout)
  if (findings) {
    return { status: 'ok', findings: findings.slice(0, MAX_FINDINGS), truncated: findings.length > MAX_FINDINGS }
  }
  if (result.code === 0) return { status: 'ok', findings: [], truncated: false }
  return {
    status: 'error',
    message: `Detector exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400) || 'no output'}`,
  }
}

/** Renders an outcome as a prompt evidence block, honest about degraded runs. */
export function formatDetectorEvidence(outcome: DetectorOutcome): string {
  if (outcome.status !== 'ok') {
    return `<evidence source="impeccable-detector" status="${outcome.status}">\n${outcome.message}\nNo deterministic scan is available — say so in the report and rely on your own pass.\n</evidence>`
  }
  const body = outcome.findings.length
    ? JSON.stringify(outcome.findings, null, 1)
    : 'Clean scan — zero findings. A clean scan is a floor, not a verdict.'
  const truncatedNote = outcome.truncated ? `\n[findings truncated to ${MAX_FINDINGS}]` : ''
  return `<evidence source="impeccable-detector" status="ok" findings="${outcome.findings.length}">\n${body}${truncatedNote}\n</evidence>`
}
