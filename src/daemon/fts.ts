/**
 * Shared FTS5 MATCH-string builder.
 *
 * User input can never be passed to FTS5 MATCH verbatim — bare hyphens,
 * quotes, `NEAR(`, `col:`, and unbalanced syntax all throw SQLITE_ERROR at
 * query time. This builder reduces input to plain word tokens and quotes each
 * one, so the resulting string is always valid FTS5 syntax (every token is a
 * quoted phrase; operators like OR/NEAR become literal quoted terms).
 *
 * Extracted from transcript.ts's proven buildFtsQuery so all FTS consumers
 * (message search, sense capture search) share one escaping path.
 */

const DEFAULT_MAX_TERMS = 8

export interface MatchQueryOptions {
  /** Maximum number of tokens to keep (default 8). */
  maxTerms?: number
  /**
   * Append a `*` prefix operator to each quoted term (`"term"*`) so FTS
   * matches on word prefixes — approximates LIKE '%term%' substring recall.
   */
  prefix?: boolean
}

export function buildMatchQuery(query: string, options: MatchQueryOptions = {}): string | null {
  const { maxTerms = DEFAULT_MAX_TERMS, prefix = false } = options
  const terms = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, maxTerms) ?? []
  if (terms.length === 0) return null
  return terms.map(t => `"${t.replace(/"/g, '""')}"${prefix ? '*' : ''}`).join(' ')
}
