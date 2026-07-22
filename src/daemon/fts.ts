/**
 * Shared FTS5 MATCH-string builder.
 *
 * User input can never be passed to FTS5 MATCH verbatim — bare hyphens,
 * quotes, `NEAR(`, `col:`, and unbalanced syntax all throw SQLITE_ERROR at
 * query time. This builder reduces input to safe quoted terms, so the
 * resulting string is always valid FTS5 syntax (operators like NEAR/col: can
 * only ever survive as literal quoted text).
 *
 * Extracted from transcript.ts's proven buildFtsQuery so all FTS consumers
 * (message search, memory search, sense capture search) share one escaping path.
 */

const DEFAULT_MAX_TERMS = 8

export type MatchMode = 'and' | 'or'

export interface MatchQueryOptions {
  /** Maximum number of terms to keep (default 8). Phrases count as one term. */
  maxTerms?: number
  /**
   * Append a `*` prefix operator to each quoted term (`"term"*`) so FTS
   * matches on word prefixes — approximates LIKE '%term%' substring recall.
   * Applies to single words only, never to phrases.
   */
  prefix?: boolean
  /**
   * `'and'` (default) requires every term — FTS5's implicit conjunction.
   * `'or'` is the recall ladder's second rung: bm25 still ranks rows matching
   * more terms higher, so broadening does not mean drowning.
   */
  mode?: MatchMode
}

/**
 * A model that writes `"on to 9"` means a phrase. The old builder flattened
 * every quote into three independent AND terms, so the more precisely the
 * caller expressed itself the less it could find. Phrase interiors are
 * sanitized to letters/digits/underscore/hyphen/space — enough to keep the
 * phrase, not enough to smuggle syntax.
 */
function extractPhrases(query: string): { phrases: string[]; rest: string } {
  const phrases: string[] = []
  const rest = query.replace(/"([^"]*)"/g, (_match, interior: string) => {
    const cleaned = String(interior).replace(/[^\p{L}\p{N}_\- ]/gu, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned) phrases.push(cleaned)
    return ' '
  })
  return { phrases, rest }
}

export function buildMatchQuery(query: string, options: MatchQueryOptions = {}): string | null {
  const { maxTerms = DEFAULT_MAX_TERMS, prefix = false, mode = 'and' } = options
  const normalized = query.normalize('NFKC')
  const { phrases, rest } = extractPhrases(normalized)

  const seen = new Set<string>()
  const terms: string[] = []
  const push = (term: string) => {
    const key = term.toLocaleLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(term)
  }
  for (const phrase of phrases) push(`"${phrase}"`)
  for (const word of rest.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (terms.length >= maxTerms) break
    push(`"${word.replace(/"/g, '""')}"${prefix ? '*' : ''}`)
  }
  const kept = terms.slice(0, maxTerms)
  if (kept.length === 0) return null
  return kept.join(mode === 'or' ? ' OR ' : ' ')
}

/** Terms in a built MATCH string — callers use it to decide whether an OR retry is worth running. */
export function countMatchTerms(query: string, options: MatchQueryOptions = {}): number {
  const built = buildMatchQuery(query, { ...options, mode: 'and' })
  if (!built) return 0
  return (built.match(/"(?:[^"]|"")*"/g) ?? []).length
}
