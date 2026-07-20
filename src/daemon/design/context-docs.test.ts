import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commonAncestor, resolveContextDocs } from './context-docs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bond-context-docs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeProject(structure: Record<string, string>): string {
  for (const [relative, content] of Object.entries(structure)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

describe('commonAncestor', () => {
  it('returns the shared directory of sibling files', () => {
    makeProject({ 'src/a.css': '', 'src/deep/b.css': '' })
    expect(commonAncestor([join(root, 'src/a.css'), join(root, 'src/deep/b.css')])).toBe(join(root, 'src'))
  })

  it('returns undefined for no paths', () => {
    expect(commonAncestor([])).toBeUndefined()
  })
})

describe('resolveContextDocs', () => {
  it('finds PRODUCT.md and DESIGN.md at the project root from a nested path', () => {
    makeProject({ 'PRODUCT.md': 'strategy', 'DESIGN.md': 'tokens', 'src/components/App.vue': '' })
    const docs = resolveContextDocs([join(root, 'src/components/App.vue')], { stopDir: root })
    expect(docs.root).toBe(root)
    expect(docs.product?.text).toBe('strategy')
    expect(docs.design?.text).toBe('tokens')
  })

  it('checks .agents/context/ and docs/ fallback locations', () => {
    makeProject({ '.agents/context/DESIGN.md': 'agents tokens', 'src/a.css': '' })
    const fromAgents = resolveContextDocs([join(root, 'src/a.css')], { stopDir: root })
    expect(fromAgents.design?.text).toBe('agents tokens')

    const second = mkdtempSync(join(tmpdir(), 'bond-context-docs2-'))
    try {
      mkdirSync(join(second, 'docs'), { recursive: true })
      mkdirSync(join(second, 'src'), { recursive: true })
      writeFileSync(join(second, 'docs/PRODUCT.md'), 'docs strategy')
      writeFileSync(join(second, 'src/a.css'), '')
      const fromDocs = resolveContextDocs([join(second, 'src/a.css')], { stopDir: second })
      expect(fromDocs.product?.text).toBe('docs strategy')
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('accepts case variants like Design.md', () => {
    makeProject({ 'Design.md': 'cased', 'src/a.css': '' })
    const docs = resolveContextDocs([join(root, 'src/a.css')], { stopDir: root })
    expect(docs.design?.text).toBe('cased')
  })

  it('stops at a git root and reports it even without docs', () => {
    makeProject({ 'PRODUCT.md': 'outer — must not be found', 'repo/.git/HEAD': '', 'repo/src/a.css': '' })
    const docs = resolveContextDocs([join(root, 'repo/src/a.css')], { stopDir: root })
    expect(docs.root).toBe(join(root, 'repo'))
    expect(docs.product).toBeUndefined()
  })

  it('does not walk above stopDir', () => {
    makeProject({ 'PRODUCT.md': 'above stop', 'inner/src/a.css': '' })
    const docs = resolveContextDocs([join(root, 'inner/src/a.css')], { stopDir: join(root, 'inner') })
    expect(docs.product).toBeUndefined()
  })

  it('returns empty for no paths', () => {
    expect(resolveContextDocs([])).toEqual({})
  })
})
