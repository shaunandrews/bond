/**
 * Resolves an agent's declared context documents for a set of target paths.
 *
 * Each directory from the targets' common ancestor upward is checked at the
 * dir itself, then .agents/context/, then docs/ — mirroring Impeccable's
 * convention so Bond and other DESIGN.md-aware tools agree on where project
 * context lives. The walk stops at a git root, the user's home, or the
 * filesystem root, whichever comes first. Doc names come from the agent
 * definition (DESIGN.md for Felix, CLAUDE.md for Q), so nothing here is
 * design-specific.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'

export interface ContextDoc {
  path: string
  text: string
}

export interface ResolvedContextDocs {
  /** The directory treated as the project root (where docs or .git were found). */
  root?: string
  /** Found documents keyed by their canonical declared name. */
  docs: Record<string, ContextDoc>
}

const MAX_WALK_DEPTH = 12
const MAX_DOC_BYTES = 256 * 1024

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function containingDir(path: string): string {
  const abs = resolve(path)
  return isDir(abs) ? abs : dirname(abs)
}

export function commonAncestor(paths: string[]): string | undefined {
  const dirs = paths.map(containingDir)
  if (!dirs.length) return undefined
  let segments = dirs[0].split(sep)
  for (const dir of dirs.slice(1)) {
    const other = dir.split(sep)
    let shared = 0
    while (shared < segments.length && shared < other.length && segments[shared] === other[shared]) shared++
    segments = segments.slice(0, shared)
  }
  return segments.join(sep) || sep
}

/** Case variants a declared doc name is accepted under (DESIGN.md / Design.md / design.md). */
function nameVariants(name: string): string[] {
  const base = name.replace(/\.md$/i, '')
  const extension = name.slice(base.length) || '.md'
  return [...new Set([name, `${base.toUpperCase()}${extension}`, `${base.charAt(0).toUpperCase()}${base.slice(1).toLowerCase()}${extension}`, `${base.toLowerCase()}${extension}`])]
}

function readDoc(dir: string, name: string): ContextDoc | undefined {
  for (const variant of nameVariants(name)) {
    const path = join(dir, variant)
    try {
      if (!statSync(path).isFile()) continue
      return { path, text: readFileSync(path, 'utf8').slice(0, MAX_DOC_BYTES) }
    } catch {
      continue
    }
  }
  return undefined
}

function docsInDir(dir: string, names: string[]): Record<string, ContextDoc> {
  for (const candidate of [dir, join(dir, '.agents', 'context'), join(dir, 'docs')]) {
    const found: Record<string, ContextDoc> = {}
    for (const name of names) {
      const doc = readDoc(candidate, name)
      if (doc) found[name] = doc
    }
    if (Object.keys(found).length) return found
  }
  return {}
}

export function resolveContextDocs(
  paths: string[],
  names: string[],
  options: { stopDir?: string } = {},
): ResolvedContextDocs {
  const start = commonAncestor(paths)
  if (!start || !names.length) return { root: start, docs: {} }
  const stopDir = resolve(options.stopDir ?? homedir())
  const fsRoot = parse(start).root

  let dir = start
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const found = docsInDir(dir, names)
    if (Object.keys(found).length) return { root: dir, docs: found }
    // A git root without docs is still the project boundary — stop there.
    if (isDir(join(dir, '.git'))) return { root: dir, docs: {} }
    if (dir === stopDir || dir === fsRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { root: start, docs: {} }
}
