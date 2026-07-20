/**
 * Migration inventory — the deterministic half of Felix's migrate verb.
 *
 * Scans source files for literal design values (colors, sizes) appearing in
 * style contexts, clusters near-duplicates (14 slightly-different grays are
 * one decision, not 14), and maps each cluster against the known tokens
 * (DESIGN.md frontmatter + CSS custom properties) into exact / near / none
 * buckets using Impeccable's published tolerances (±6 per RGB channel,
 * ±0.5px). Felix judges the near bucket and plans the campaign; this module
 * only produces evidence. `var(...)` usages are by definition on-system —
 * only literals are drift.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

export type CanonicalValue =
  | { kind: 'color'; r: number; g: number; b: number; a: number }
  | { kind: 'length'; px: number }

export interface LiteralOccurrence {
  file: string
  line: number
  property: string
  raw: string
  canonical: CanonicalValue
}

export interface TokenDef {
  name: string
  raw: string
  canonical: CanonicalValue
  source: string
}

export interface ValueCluster {
  kind: CanonicalValue['kind']
  representative: CanonicalValue
  values: string[]
  occurrences: LiteralOccurrence[]
}

export type MatchBucket = 'exact' | 'near' | 'none'

export interface MappedCluster {
  cluster: ValueCluster
  bucket: MatchBucket
  token?: TokenDef
  distance?: number
}

export const COLOR_EXACT_TOLERANCE = 6
export const COLOR_NEAR_TOLERANCE = 20
export const LENGTH_EXACT_TOLERANCE = 0.5
export const LENGTH_NEAR_TOLERANCE = 2
const ALPHA_TOLERANCE = 0.04
const REM_PX = 16

// ---------------------------------------------------------------------------
// Value parsing

function hexChannel(hex: string): number {
  return hex.length === 1 ? parseInt(hex + hex, 16) : parseInt(hex, 16)
}

export function parseColor(raw: string): CanonicalValue | undefined {
  const value = raw.trim().toLowerCase()

  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    const digits = hex[1]
    const short = digits.length <= 4
    const step = short ? 1 : 2
    const parts = []
    for (let index = 0; index < digits.length; index += step) parts.push(hexChannel(digits.slice(index, index + step)))
    const [r, g, b, alphaChannel] = parts
    return { kind: 'color', r, g, b, a: parts.length === 4 ? alphaChannel / 255 : 1 }
  }

  const rgb = value.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/)
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
    return { kind: 'color', r: Math.round(+rgb[1]), g: Math.round(+rgb[2]), b: Math.round(+rgb[3]), a: alpha }
  }

  const hsl = value.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/)
  if (hsl) {
    const h = ((+hsl[1] % 360) + 360) % 360
    const s = +hsl[2] / 100
    const l = +hsl[3] / 100
    const alpha = hsl[4] === undefined ? 1 : hsl[4].endsWith('%') ? parseFloat(hsl[4]) / 100 : parseFloat(hsl[4])
    const chroma = (1 - Math.abs(2 * l - 1)) * s
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - chroma / 2
    const [r1, g1, b1] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
      : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x]
    return {
      kind: 'color',
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
      a: alpha,
    }
  }

  return undefined
}

export function parseLength(raw: string): CanonicalValue | undefined {
  const match = raw.trim().toLowerCase().match(/^(-?\d*\.?\d+)(px|rem)$/)
  if (!match) return undefined
  const amount = parseFloat(match[1])
  return { kind: 'length', px: match[2] === 'rem' ? amount * REM_PX : amount }
}

export function parseValue(raw: string): CanonicalValue | undefined {
  return parseColor(raw) ?? parseLength(raw)
}

export function valueDistance(a: CanonicalValue, b: CanonicalValue): number | undefined {
  if (a.kind !== b.kind) return undefined
  if (a.kind === 'color' && b.kind === 'color') {
    if (Math.abs(a.a - b.a) > ALPHA_TOLERANCE) return undefined
    return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b))
  }
  if (a.kind === 'length' && b.kind === 'length') return Math.abs(a.px - b.px)
  return undefined
}

function exactTolerance(kind: CanonicalValue['kind']): number {
  return kind === 'color' ? COLOR_EXACT_TOLERANCE : LENGTH_EXACT_TOLERANCE
}

function nearTolerance(kind: CanonicalValue['kind']): number {
  return kind === 'color' ? COLOR_NEAR_TOLERANCE : LENGTH_NEAR_TOLERANCE
}

// ---------------------------------------------------------------------------
// Token sources

/**
 * Extracts tokens from DESIGN.md YAML frontmatter (colors/rounded/spacing
 * leaves + typography fontSize leaves). Hand-rolled indentation walk — the
 * spec's frontmatter is a flat-ish literal subset, not arbitrary YAML.
 */
export function extractDesignMdTokens(designMdText: string, source = 'DESIGN.md'): TokenDef[] {
  const lines = designMdText.split('\n')
  if (lines[0]?.trim() !== '---') return []
  const tokens: TokenDef[] = []
  const stack: Array<{ indent: number; key: string }> = []

  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const match = line.match(/^(\s*)([\w][\w-]*)\s*:\s*(.*)$/)
    if (!match) continue
    const indent = match[1].length
    const key = match[2]
    const value = match[3].trim().replace(/^["']|["']$/g, '')
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    if (!value) {
      stack.push({ indent, key })
      continue
    }
    if (value.includes('{')) continue // token refs resolve elsewhere; only literals are matchable
    const path = [...stack.map(entry => entry.key), key]
    const group = path[0]
    const isTypeSize = group === 'typography' && key === 'fontSize'
    if (group !== 'colors' && group !== 'rounded' && group !== 'spacing' && !isTypeSize) continue
    const canonical = parseValue(value)
    if (canonical) tokens.push({ name: path.join('.'), raw: value, canonical, source })
  }
  return tokens
}

/** CSS custom property definitions are the code-side token vocabulary. */
export function extractCustomPropTokens(text: string, source: string): TokenDef[] {
  const tokens: TokenDef[] = []
  for (const match of text.matchAll(/--([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const canonical = parseValue(match[2].trim())
    if (canonical) tokens.push({ name: `--${match[1]}`, raw: match[2].trim(), canonical, source })
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Literal inventory

const COLOR_PROP = /(?:^|[^\w-])(color|background(?:-color)?|border(?:-[a-z]+)*-color|border|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color)\s*:/
const LENGTH_PROP = /(?:^|[^\w-])(font-size|border-radius|gap|row-gap|column-gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?)\s*:/
const COLOR_LITERAL = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|(?:rgba?|hsla?)\([^)]*\)/gi
const LENGTH_LITERAL = /-?\d*\.?\d+(?:px|rem)\b/g
const TAILWIND_COLOR = /(?:text|bg|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|divide|accent|caret)-\[(#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([^\]]*\))\]/gi
const TAILWIND_LENGTH = /(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap(?:-[xy])?|text|leading|rounded(?:-[a-z]+)?|space-[xy])-\[(-?\d*\.?\d+(?:px|rem))\]/g

/** camelCase JS style keys (backgroundColor) participate as their CSS names. */
function cssifyLine(line: string): string {
  return line.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a}-${b.toLowerCase()}`)
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('<!--')
}

export function inventoryLiterals(text: string, file: string): LiteralOccurrence[] {
  const occurrences: LiteralOccurrence[] = []
  const lines = text.split('\n')

  lines.forEach((sourceLine, index) => {
    if (isCommentLine(sourceLine)) return
    const line = cssifyLine(sourceLine)
    const lineNumber = index + 1
    const definesToken = /--[\w-]+\s*:/.test(line)
    const usesVar = line.includes('var(')

    // Declaration-context literals. Token definitions ARE the vocabulary and
    // var() usages (including fallbacks) are on-system — skip both.
    if (!definesToken && !usesVar) {
      const colorProp = line.match(COLOR_PROP)
      if (colorProp) {
        for (const literal of line.matchAll(COLOR_LITERAL)) {
          const canonical = parseColor(literal[0])
          if (canonical) occurrences.push({ file, line: lineNumber, property: colorProp[1], raw: literal[0], canonical })
        }
      }
      const lengthProp = line.match(LENGTH_PROP)
      if (lengthProp) {
        const value = line.slice(line.indexOf(':', line.search(LENGTH_PROP)) + 1)
        for (const literal of value.matchAll(LENGTH_LITERAL)) {
          const canonical = parseLength(literal[0])
          if (canonical && canonical.kind === 'length' && canonical.px !== 0) {
            occurrences.push({ file, line: lineNumber, property: lengthProp[1], raw: literal[0], canonical })
          }
        }
      }
    }

    // Tailwind arbitrary values are off-scale by definition.
    for (const literal of sourceLine.matchAll(TAILWIND_COLOR)) {
      const canonical = parseColor(literal[1])
      if (canonical) occurrences.push({ file, line: lineNumber, property: 'tailwind-arbitrary', raw: literal[0], canonical })
    }
    for (const literal of sourceLine.matchAll(TAILWIND_LENGTH)) {
      const canonical = parseLength(literal[1])
      if (canonical && canonical.kind === 'length' && canonical.px !== 0) {
        occurrences.push({ file, line: lineNumber, property: 'tailwind-arbitrary', raw: literal[0], canonical })
      }
    }
  })

  return occurrences
}

// ---------------------------------------------------------------------------
// Clustering + mapping

export function clusterOccurrences(occurrences: LiteralOccurrence[]): ValueCluster[] {
  const clusters: ValueCluster[] = []
  for (const occurrence of occurrences) {
    const existing = clusters.find(cluster => {
      const distance = valueDistance(cluster.representative, occurrence.canonical)
      return distance !== undefined && distance <= exactTolerance(cluster.kind)
    })
    if (existing) {
      existing.occurrences.push(occurrence)
      if (!existing.values.includes(occurrence.raw)) existing.values.push(occurrence.raw)
    } else {
      clusters.push({
        kind: occurrence.canonical.kind,
        representative: occurrence.canonical,
        values: [occurrence.raw],
        occurrences: [occurrence],
      })
    }
  }
  return clusters.sort((a, b) => b.occurrences.length - a.occurrences.length)
}

export function mapClusters(clusters: ValueCluster[], tokens: TokenDef[]): MappedCluster[] {
  return clusters.map(cluster => {
    let best: { token: TokenDef; distance: number } | undefined
    for (const token of tokens) {
      const distance = valueDistance(cluster.representative, token.canonical)
      if (distance === undefined) continue
      if (!best || distance < best.distance) best = { token, distance }
    }
    if (!best) return { cluster, bucket: 'none' as const }
    const bucket: MatchBucket = best.distance <= exactTolerance(cluster.kind)
      ? 'exact'
      : best.distance <= nearTolerance(cluster.kind) ? 'near' : 'none'
    return bucket === 'none'
      ? { cluster, bucket }
      : { cluster, bucket, token: best.token, distance: best.distance }
  })
}

// ---------------------------------------------------------------------------
// Evidence + filesystem entry point

function describeValue(canonical: CanonicalValue): string {
  return canonical.kind === 'color'
    ? `rgb(${canonical.r} ${canonical.g} ${canonical.b}${canonical.a < 1 ? ` / ${canonical.a.toFixed(2)}` : ''})`
    : `${canonical.px}px`
}

export function formatMigrationEvidence(mapped: MappedCluster[], tokens: TokenDef[], scannedFiles: number): string {
  const lines: string[] = [
    `<evidence source="migration-inventory" files="${scannedFiles}" tokens="${tokens.length}" clusters="${mapped.length}">`,
    `Known tokens: ${tokens.length ? tokens.map(token => `${token.name}=${token.raw}`).join(', ') : 'NONE FOUND — there is no token vocabulary yet'}`,
    '',
  ]
  for (const entry of mapped) {
    const sample = entry.cluster.occurrences.slice(0, 3).map(o => `${o.file}:${o.line}`).join(', ')
    const extra = entry.cluster.occurrences.length > 3 ? ` (+${entry.cluster.occurrences.length - 3} more)` : ''
    const match = entry.bucket === 'none'
      ? 'no candidate token'
      : `${entry.bucket} match → ${entry.token!.name} (${entry.token!.raw}, Δ${entry.distance})`
    lines.push(`- ${describeValue(entry.cluster.representative)} as [${entry.cluster.values.join(' | ')}] ×${entry.cluster.occurrences.length} — ${match} — ${sample}${extra}`)
  }
  if (!mapped.length) lines.push('- No off-system literals found in scope.')
  lines.push('</evidence>')
  return lines.join('\n')
}

const SCANNABLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.vue', '.tsx', '.jsx', '.ts', '.js', '.html', '.svelte', '.astro'])
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage'])
const MAX_FILES = 400
const MAX_FILE_BYTES = 512 * 1024

function collectFiles(path: string, collected: string[]): void {
  if (collected.length >= MAX_FILES) return
  let stats
  try {
    stats = statSync(path)
  } catch {
    return
  }
  if (stats.isFile()) {
    if (SCANNABLE_EXTENSIONS.has(extname(path)) && stats.size <= MAX_FILE_BYTES) collected.push(path)
    return
  }
  if (!stats.isDirectory()) return
  for (const entry of readdirSync(path)) {
    if (SKIPPED_DIRS.has(entry) || entry.startsWith('.')) continue
    collectFiles(join(path, entry), collected)
    if (collected.length >= MAX_FILES) return
  }
}

export interface MigrationInventory {
  tokens: TokenDef[]
  mapped: MappedCluster[]
  evidence: string
  scannedFiles: number
}

export function runMigrationInventory(paths: string[], options: { designMdText?: string } = {}): MigrationInventory {
  const files: string[] = []
  for (const path of paths) collectFiles(resolve(path), files)

  const tokens: TokenDef[] = options.designMdText ? extractDesignMdTokens(options.designMdText) : []
  const occurrences: LiteralOccurrence[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    tokens.push(...extractCustomPropTokens(text, file))
    occurrences.push(...inventoryLiterals(text, file))
  }

  const mapped = mapClusters(clusterOccurrences(occurrences), tokens)
  return { tokens, mapped, evidence: formatMigrationEvidence(mapped, tokens, files.length), scannedFiles: files.length }
}
