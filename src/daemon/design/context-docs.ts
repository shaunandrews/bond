/**
 * Resolves a project's design context documents (PRODUCT.md / DESIGN.md) for
 * a set of target paths. Resolution mirrors Impeccable's convention so the
 * two tools agree on where context lives: each directory from the targets'
 * common ancestor upward is checked at the dir itself, then .agents/context/,
 * then docs/. The walk stops at a git root, the user's home, or filesystem
 * root — whichever comes first.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'

export interface ContextDoc {
  path: string
  text: string
}

export interface ResolvedContextDocs {
  /** The directory treated as the project root (where a doc or .git was found, else the common ancestor). */
  root?: string
  product?: ContextDoc
  design?: ContextDoc
}

const PRODUCT_NAMES = ['PRODUCT.md', 'Product.md', 'product.md']
const DESIGN_NAMES = ['DESIGN.md', 'Design.md', 'design.md']
const MAX_WALK_DEPTH = 12
const MAX_DOC_BYTES = 256 * 1024

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A file's containing directory; a directory itself; a missing path's parent. */
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
  const ancestor = segments.join(sep)
  return ancestor || sep
}

function readDoc(dir: string, names: string[]): ContextDoc | undefined {
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) continue
      const text = readFileSync(path, 'utf8').slice(0, MAX_DOC_BYTES)
      return { path, text }
    } catch {
      continue
    }
  }
  return undefined
}

function docsInDir(dir: string): { product?: ContextDoc; design?: ContextDoc } {
  for (const candidate of [dir, join(dir, '.agents', 'context'), join(dir, 'docs')]) {
    const product = readDoc(candidate, PRODUCT_NAMES)
    const design = readDoc(candidate, DESIGN_NAMES)
    if (product || design) return { product, design }
  }
  return {}
}

export function resolveContextDocs(paths: string[], options: { stopDir?: string } = {}): ResolvedContextDocs {
  const start = commonAncestor(paths)
  if (!start) return {}
  const stopDir = resolve(options.stopDir ?? homedir())
  const fsRoot = parse(start).root

  let dir = start
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const found = docsInDir(dir)
    if (found.product || found.design) return { root: dir, ...found }
    // A git root without docs is still the project boundary — stop there.
    if (isDir(join(dir, '.git'))) return { root: dir }
    if (dir === stopDir || dir === fsRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { root: start }
}
