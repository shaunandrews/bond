/**
 * Structure hidden inside MCP tool descriptions.
 *
 * Proxy-style servers (context-a8c, and every "load a provider" server after
 * it) put their entire surface in one tool's description as a bulleted
 * catalog: a lead sentence, then `- name: what it does` per provider. Rendered
 * as prose that collapses to a 2,500-character wall — the newlines are there,
 * HTML just eats them.
 *
 * Parsing it back into entries is what lets the UI show a tool's real reach
 * instead of hiding it behind an ellipsis.
 */

export interface CatalogEntry {
  name: string
  description: string
  /** First sentence — enough for a chip tooltip. */
  summary: string
}

export interface ParsedToolDescription {
  /** The prose before the catalog (or the whole description when there isn't one). */
  summary: string
  /** Catalog entries, empty for an ordinary description. */
  entries: CatalogEntry[]
}

// `- slack: Fetch Slack information…` — a bullet, a slug, a colon.
const ENTRY_RE = /^[-*•]\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*(.+)$/

/** First sentence, or the whole thing when it has no sentence break. */
export function firstSentence(text: string, maxChars = 160): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^(.+?[.!?])(\s|$)/s)
  const sentence = (match?.[1] ?? trimmed).replace(/\s+/g, ' ')
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars).trimEnd()}…` : sentence
}

/**
 * Split a description into its lead prose and any catalog entries.
 *
 * Entries can wrap across lines, so a line that isn't a new bullet continues
 * the previous one. A description with fewer than two entries isn't a catalog
 * — one stray "- note: …" line shouldn't restructure the whole row.
 */
export function parseToolDescription(description: string | undefined): ParsedToolDescription {
  const text = (description ?? '').trim()
  if (!text) return { summary: '', entries: [] }

  const lines = text.split('\n')
  const leadLines: string[] = []
  const raw: Array<{ name: string; parts: string[] }> = []

  for (const line of lines) {
    const match = line.trim().match(ENTRY_RE)
    if (match) {
      raw.push({ name: match[1], parts: [match[2].trim()] })
      continue
    }
    if (raw.length) {
      // Continuation of the entry above; a blank line just separates entries.
      if (line.trim()) raw[raw.length - 1].parts.push(line.trim())
    } else {
      leadLines.push(line)
    }
  }

  if (raw.length < 2) return { summary: text, entries: [] }

  const entries = raw.map(({ name, parts }) => {
    const entryText = parts.join(' ').replace(/\s+/g, ' ').trim()
    return { name, description: entryText, summary: firstSentence(entryText) }
  })

  // Drop a dangling "Available providers:" style lead-in — the list says it.
  const summary = leadLines.join('\n').trim().replace(/[:\-—]\s*$/, '').trim()
  return { summary, entries }
}
