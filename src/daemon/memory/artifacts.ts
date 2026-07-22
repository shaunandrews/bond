import { sep } from 'node:path'
import type { WorkingArtifact, WorkingState } from './types'

/**
 * Deterministic artifact capture. If Bond performed the action, Bond knows the
 * fact — capture it at the seam where it is born (the tool-event stream), not
 * by re-inferring it from prose. This is not an optimization: the observer
 * filters the transcript to user/bond TEXT before it sees anything, so the tool
 * calls that write documents and file issues are invisible to it. Without this
 * path an artifact could enter working memory only if someone typed its path
 * into chat.
 */
export interface ToolEndEvent {
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  isError?: boolean
}

export interface ArtifactDeps {
  libraryDir: string
  skillsDir: string
  now?: string
}

/** Reads of the same path signal "the thing being worked on"; one read is noise. */
const readCounts = new Map<string, number>()

/** In-memory only: losing the counter on a daemon restart costs one extra read. */
export function resetReadCountsForTest(): void {
  readCounts.clear()
}

const LINEAR_ISSUE_KEY = /\b[A-Z]{2,6}-\d+\b/

export function workingPatchFromToolEvent(event: ToolEndEvent, deps: ArtifactDeps): Partial<WorkingState> | null {
  if (event.isError) return null
  const now = deps.now ?? new Date().toISOString()
  const path = typeof event.args.path === 'string' ? event.args.path : null

  if ((event.toolName === 'write' || event.toolName === 'edit') && path) {
    return { artifacts: [artifact(isUnder(path, deps.libraryDir) ? 'library' : 'file', path, now)] }
  }

  if (event.toolName === 'read' && path) {
    const skill = skillNameFromPath(path, deps.skillsDir)
    if (skill) return { activeSkill: skill }
    const count = (readCounts.get(path) ?? 0) + 1
    readCounts.set(path, count)
    if (count < 2) return null
    return { artifacts: [artifact(isUnder(path, deps.libraryDir) ? 'library' : 'file', path, now)] }
  }

  // Deliberately narrow. False negatives are fine; a bare [A-Z]{2,6}-\d+ over
  // arbitrary tool output would match prose like "UTF-8", which is why the
  // regex only runs on Linear-flavored calls.
  if (event.toolName === 'mcp' || event.toolName.startsWith('mcp__')) {
    const argsText = JSON.stringify(event.args ?? {}).toLocaleLowerCase()
    if (!argsText.includes('linear')) return null
    const resultText = typeof event.result === 'string' ? event.result : safeStringify(event.result)
    const key = resultText.match(LINEAR_ISSUE_KEY)?.[0]
    if (!key) return null
    return { artifacts: [artifact('issue', key, now)] }
  }

  return null
}

function artifact(kind: WorkingArtifact['kind'], ref: string, lastTouchedAt: string): WorkingArtifact {
  return { kind, ref, lastTouchedAt }
}

function isUnder(path: string, dir: string): boolean {
  if (!dir) return false
  const normalized = dir.endsWith(sep) ? dir : `${dir}${sep}`
  return path.startsWith(normalized)
}

/** `<skillsDir>/<name>/SKILL.md` → `<name>`. */
function skillNameFromPath(path: string, skillsDir: string): string | null {
  if (!isUnder(path, skillsDir)) return null
  const rest = path.slice(skillsDir.endsWith(sep) ? skillsDir.length : skillsDir.length + 1)
  const parts = rest.split(sep)
  if (parts.length !== 2 || parts[1].toLocaleUpperCase() !== 'SKILL.MD') return null
  return parts[0] || null
}

function safeStringify(value: unknown): string {
  if (value == null) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
