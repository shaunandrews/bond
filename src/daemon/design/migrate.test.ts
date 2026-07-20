import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clusterOccurrences,
  extractCustomPropTokens,
  extractDesignMdTokens,
  formatMigrationEvidence,
  inventoryLiterals,
  mapClusters,
  parseColor,
  parseLength,
  runMigrationInventory,
  valueDistance,
  type LiteralOccurrence,
  type TokenDef,
} from './migrate'

function color(r: number, g: number, b: number, a = 1) {
  return { kind: 'color' as const, r, g, b, a }
}

function occurrence(raw: string, overrides: Partial<LiteralOccurrence> = {}): LiteralOccurrence {
  const canonical = parseColor(raw) ?? parseLength(raw)
  if (!canonical) throw new Error(`unparseable test value: ${raw}`)
  return { file: 'a.css', line: 1, property: 'color', raw, canonical, ...overrides }
}

function token(name: string, raw: string): TokenDef {
  const canonical = parseColor(raw) ?? parseLength(raw)
  if (!canonical) throw new Error(`unparseable test token: ${raw}`)
  return { name, raw, canonical, source: 'test' }
}

describe('parseColor', () => {
  it('parses hex forms', () => {
    expect(parseColor('#fff')).toEqual(color(255, 255, 255))
    expect(parseColor('#1a2b3c')).toEqual(color(26, 43, 60))
    expect(parseColor('#00000080')!).toMatchObject({ r: 0, g: 0, b: 0 })
    expect(parseColor('#00000080')!.kind === 'color' && (parseColor('#00000080') as any).a).toBeCloseTo(0.5, 1)
  })

  it('parses rgb/rgba in comma and slash syntax', () => {
    expect(parseColor('rgb(26, 43, 60)')).toEqual(color(26, 43, 60))
    expect(parseColor('rgba(26, 43, 60, 0.5)')).toEqual(color(26, 43, 60, 0.5))
    expect(parseColor('rgb(26 43 60 / 50%)')).toEqual(color(26, 43, 60, 0.5))
  })

  it('converts hsl to rgb', () => {
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual(color(255, 0, 0))
    expect(parseColor('hsl(120 100% 25%)')).toEqual(color(0, 128, 0))
  })

  it('rejects non-colors', () => {
    expect(parseColor('inherit')).toBeUndefined()
    expect(parseColor('#12345')).toBeUndefined()
    expect(parseColor('var(--x)')).toBeUndefined()
  })
})

describe('parseLength', () => {
  it('parses px and converts rem at 16px', () => {
    expect(parseLength('12px')).toEqual({ kind: 'length', px: 12 })
    expect(parseLength('1.5rem')).toEqual({ kind: 'length', px: 24 })
  })

  it('rejects other units and bare numbers', () => {
    expect(parseLength('2em')).toBeUndefined()
    expect(parseLength('50%')).toBeUndefined()
    expect(parseLength('12')).toBeUndefined()
  })
})

describe('valueDistance', () => {
  it('is the max channel delta for colors', () => {
    expect(valueDistance(color(10, 20, 30), color(12, 26, 30))).toBe(6)
  })

  it('is undefined across kinds and across alpha differences', () => {
    expect(valueDistance(color(0, 0, 0), { kind: 'length', px: 4 })).toBeUndefined()
    expect(valueDistance(color(0, 0, 0, 1), color(0, 0, 0, 0.5))).toBeUndefined()
  })
})

describe('extractDesignMdTokens', () => {
  const designMd = [
    '---',
    'colors:',
    '  oxblood-deep: "#4a1520"',
    '  surface: "#ffffff"',
    '  aliased: "{colors.surface}"',
    'rounded:',
    '  md: 6px',
    'spacing:',
    '  sm: 0.5rem',
    'typography:',
    '  body:',
    '    fontFamily: Inter',
    '    fontSize: 16px',
    '---',
    '',
    '## Overview',
  ].join('\n')

  it('collects color, rounded, spacing, and typography fontSize leaves', () => {
    const tokens = extractDesignMdTokens(designMd)
    const names = tokens.map(t => t.name)
    expect(names).toContain('colors.oxblood-deep')
    expect(names).toContain('rounded.md')
    expect(names).toContain('spacing.sm')
    expect(names).toContain('typography.body.fontSize')
    expect(names).not.toContain('colors.aliased')
    expect(names).not.toContain('typography.body.fontFamily')
  })

  it('returns nothing without frontmatter', () => {
    expect(extractDesignMdTokens('## Overview\ncolors: none')).toEqual([])
  })
})

describe('extractCustomPropTokens', () => {
  it('collects parseable custom property definitions', () => {
    const css = ':root { --accent: #7a5c3b; --radius-md: 6px; --font-sans: Inter, sans-serif; }'
    const tokens = extractCustomPropTokens(css, 'app.css')
    expect(tokens.map(t => t.name)).toEqual(['--accent', '--radius-md'])
  })
})

describe('inventoryLiterals', () => {
  it('flags literals in declaration contexts', () => {
    const found = inventoryLiterals('a { color: #ff0000; font-size: 13px; }', 'a.css')
    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({ property: 'color', raw: '#ff0000', line: 1 })
    expect(found[1]).toMatchObject({ property: 'font-size', raw: '13px' })
  })

  it('skips token definitions, var() usages, comments, and zero lengths', () => {
    const text = [
      '--accent: #ff0000;',
      'color: var(--accent, #ff0000);',
      '/* color: #123456; */',
      '// color: #123456;',
      'margin: 0;',
    ].join('\n')
    expect(inventoryLiterals(text, 'a.css')).toHaveLength(0)
  })

  it('handles camelCase JS style keys', () => {
    const found = inventoryLiterals("style={{ backgroundColor: '#123456' }}", 'a.tsx')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ property: 'background-color', raw: '#123456' })
  })

  it('flags Tailwind arbitrary values for colors and lengths', () => {
    const found = inventoryLiterals('<div class="bg-[#1a2b3c] p-[13px] text-sm">', 'a.vue')
    expect(found.map(f => f.raw)).toEqual(['bg-[#1a2b3c]', 'p-[13px]'])
    expect(found.every(f => f.property === 'tailwind-arbitrary')).toBe(true)
  })

  it('ignores color-like tokens outside style contexts', () => {
    expect(inventoryLiterals('see PR #155 and issue #abc123 for context', 'notes.ts')).toHaveLength(0)
  })
})

describe('clusterOccurrences', () => {
  it('merges values within the exact tolerance and sorts by frequency', () => {
    const clusters = clusterOccurrences([
      occurrence('#111111'),
      occurrence('rgb(20, 20, 20)'),
      occurrence('#ff0000'),
      occurrence('#111111', { line: 9 }),
    ])
    expect(clusters).toHaveLength(2)
    expect(clusters[0].occurrences).toHaveLength(3)
    expect(clusters[0].values).toEqual(['#111111', 'rgb(20, 20, 20)'])
    expect(clusters[1].values).toEqual(['#ff0000'])
  })

  it('keeps colors and lengths in separate clusters', () => {
    const clusters = clusterOccurrences([occurrence('#111111'), occurrence('13px')])
    expect(clusters).toHaveLength(2)
  })
})

describe('mapClusters', () => {
  const tokens = [token('--ink', '#1a1c1f'), token('--radius-md', '6px')]

  it('buckets exact, near, and none by tolerance', () => {
    const [exact] = mapClusters(clusterOccurrences([occurrence('#1a1c1f')]), tokens)
    expect(exact).toMatchObject({ bucket: 'exact', token: { name: '--ink' }, distance: 0 })

    const [near] = mapClusters(clusterOccurrences([occurrence('#242628')]), tokens)
    expect(near.bucket).toBe('near')
    expect(near.token?.name).toBe('--ink')

    const [none] = mapClusters(clusterOccurrences([occurrence('#ff0000')]), tokens)
    expect(none).toEqual({ cluster: none.cluster, bucket: 'none' })
  })

  it('maps lengths against length tokens', () => {
    const [exact] = mapClusters(clusterOccurrences([occurrence('6px', { property: 'border-radius' })]), tokens)
    expect(exact).toMatchObject({ bucket: 'exact', token: { name: '--radius-md' } })
  })
})

describe('runMigrationInventory', () => {
  it('scans a project end-to-end: tokens from :root and DESIGN.md, literals clustered and mapped', () => {
    const root = mkdtempSync(join(tmpdir(), 'bond-migrate-'))
    try {
      mkdirSync(join(root, 'node_modules/dep'), { recursive: true })
      writeFileSync(join(root, 'app.css'), ':root { --accent: #7a5c3b; }\n.btn { color: #7a5c3b; background: #ff00aa; }')
      writeFileSync(join(root, 'node_modules/dep/x.css'), '.x { color: #123456; }')
      const designMdText = '---\nrounded:\n  md: 6px\n---\n'

      const inventory = runMigrationInventory([root], { designMdText })
      expect(inventory.scannedFiles).toBe(1)
      expect(inventory.tokens.map(t => t.name).sort()).toEqual(['--accent', 'rounded.md'])
      expect(inventory.mapped).toHaveLength(2)
      const buckets = Object.fromEntries(inventory.mapped.map(m => [m.cluster.values[0], m.bucket]))
      expect(buckets['#7a5c3b']).toBe('exact')
      expect(buckets['#ff00aa']).toBe('none')
      expect(inventory.evidence).toContain('source="migration-inventory"')
      expect(inventory.evidence).not.toContain('#123456')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an honest empty inventory', () => {
    const evidence = formatMigrationEvidence([], [], 0)
    expect(evidence).toContain('NONE FOUND')
    expect(evidence).toContain('No off-system literals')
  })
})
