import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commonAncestor, resolveContextDocs } from './context-docs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bond-agent-docs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function make(structure: Record<string, string>): void {
  for (const [relative, content] of Object.entries(structure)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
}

describe('commonAncestor', () => {
  it('returns the shared directory of sibling paths', () => {
    make({ 'src/a.css': '', 'src/deep/b.css': '' })
    expect(commonAncestor([join(root, 'src/a.css'), join(root, 'src/deep/b.css')])).toBe(join(root, 'src'))
  })

  it('returns undefined for no paths', () => {
    expect(commonAncestor([])).toBeUndefined()
  })
})

describe('resolveContextDocs', () => {
  it('finds declared docs at the project root from a nested path', () => {
    make({ 'DESIGN.md': 'tokens', 'PRODUCT.md': 'strategy', 'src/components/App.vue': '' })
    const resolved = resolveContextDocs([join(root, 'src/components/App.vue')], ['PRODUCT.md', 'DESIGN.md'], { stopDir: root })
    expect(resolved.root).toBe(root)
    expect(resolved.docs['DESIGN.md'].text).toBe('tokens')
    expect(resolved.docs['PRODUCT.md'].text).toBe('strategy')
  })

  it('only returns docs the agent declared', () => {
    make({ 'DESIGN.md': 'tokens', 'CLAUDE.md': 'conventions', 'src/a.css': '' })
    const resolved = resolveContextDocs([join(root, 'src/a.css')], ['CLAUDE.md'], { stopDir: root })
    expect(Object.keys(resolved.docs)).toEqual(['CLAUDE.md'])
  })

  it('checks .agents/context/ and docs/ fallbacks', () => {
    make({ '.agents/context/DESIGN.md': 'agents tokens', 'src/a.css': '' })
    expect(resolveContextDocs([join(root, 'src/a.css')], ['DESIGN.md'], { stopDir: root }).docs['DESIGN.md'].text)
      .toBe('agents tokens')
  })

  it('accepts case variants of a declared name', () => {
    make({ 'design.md': 'lower', 'src/a.css': '' })
    expect(resolveContextDocs([join(root, 'src/a.css')], ['DESIGN.md'], { stopDir: root }).docs['DESIGN.md'].text).toBe('lower')
  })

  it('stops at a git root rather than leaking a parent project\'s docs', () => {
    make({ 'DESIGN.md': 'outer', 'repo/.git/HEAD': '', 'repo/src/a.css': '' })
    const resolved = resolveContextDocs([join(root, 'repo/src/a.css')], ['DESIGN.md'], { stopDir: root })
    expect(resolved.root).toBe(join(root, 'repo'))
    expect(resolved.docs).toEqual({})
  })

  it('returns nothing when the agent declares no docs', () => {
    make({ 'DESIGN.md': 'tokens', 'src/a.css': '' })
    expect(resolveContextDocs([join(root, 'src/a.css')], [], { stopDir: root }).docs).toEqual({})
  })
})
