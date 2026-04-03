export type TextSegment = { type: 'text'; content: string }
export type ArtifactSegment = {
  type: 'artifact'
  title?: string
  layout?: 'normal' | 'wide' | 'full'
  chrome?: 'default' | 'none'
  content: string
}
export type EmbedSegment = {
  type: 'embed'
  embedType: string
  attrs: Record<string, string>
}
export type MessageSegment = TextSegment | ArtifactSegment | EmbedSegment

const CLOSE_TAG = '</bond-artifact>'

/**
 * Parse attribute value from an opening tag string.
 * Handles: attr="value", attr='value', attr=value
 */
function getAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`)
  const m = tag.match(re)
  if (!m) return undefined
  return m[1] ?? m[2] ?? m[3]
}

/** Extract all attributes from a tag string into a Record */
function getAllAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
  // Skip the tag name itself
  const tagBody = tag.replace(/^<bond-embed\s*/, '').replace(/\/?>$/, '')
  let m: RegExpExecArray | null
  while ((m = re.exec(tagBody)) !== null) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

/**
 * Find the next start-of-line occurrence of a tag prefix.
 * Must appear at start of string or after a newline (possibly with leading whitespace).
 */
function findTagAtLineStart(text: string, tag: string, from: number): number {
  let pos = from
  while (pos < text.length) {
    const idx = text.indexOf(tag, pos)
    if (idx === -1) return -1

    if (idx > 0) {
      const lineStart = text.lastIndexOf('\n', idx - 1)
      const before = text.slice(lineStart + 1, idx)
      if (before.trim() !== '') {
        pos = idx + tag.length
        continue
      }
    }

    return idx
  }
  return -1
}

/**
 * Parse a message string into alternating text, artifact, and embed segments.
 *
 * Handles streaming gracefully:
 * - If an opening tag is found but no closing tag, everything after the
 *   opening tag's `>` is treated as in-progress artifact content.
 * - If the opening tag itself is incomplete (no `>`), it stays in a text segment.
 *
 * Only matches tags at the start of a line to avoid false positives
 * when the agent mentions tags in inline code or prose.
 */
export function parseMessage(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    // Find next artifact or embed tag, whichever comes first
    const artifactStart = findTagAtLineStart(text, '<bond-artifact', cursor)
    const embedStart = findTagAtLineStart(text, '<bond-embed', cursor)

    // Determine which tag comes first
    let nextTag: 'artifact' | 'embed' | 'none' = 'none'
    let nextStart = -1

    if (artifactStart !== -1 && (embedStart === -1 || artifactStart <= embedStart)) {
      nextTag = 'artifact'
      nextStart = artifactStart
    } else if (embedStart !== -1) {
      nextTag = 'embed'
      nextStart = embedStart
    }

    if (nextTag === 'none') {
      const remaining = text.slice(cursor)
      if (remaining) segments.push({ type: 'text', content: remaining })
      break
    }

    // Text before the tag
    if (nextStart > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, nextStart) })
    }

    if (nextTag === 'embed') {
      // Self-closing tag: <bond-embed ... />
      // Also accept <bond-embed ... > (without self-closing slash)
      const tagEnd = text.indexOf('>', nextStart)
      if (tagEnd === -1) {
        segments.push({ type: 'text', content: text.slice(nextStart) })
        break
      }

      const fullTag = text.slice(nextStart, tagEnd + 1)
      const attrs = getAllAttrs(fullTag)
      const embedType = attrs.type ?? 'unknown'
      delete attrs.type

      segments.push({ type: 'embed', embedType, attrs })
      cursor = tagEnd + 1
    } else {
      // Artifact tag with content body
      const openEnd = text.indexOf('>', nextStart)
      if (openEnd === -1) {
        segments.push({ type: 'text', content: text.slice(nextStart) })
        break
      }

      const openingTag = text.slice(nextStart, openEnd + 1)
      const title = getAttr(openingTag, 'title')
      const layout = getAttr(openingTag, 'layout') as ArtifactSegment['layout']
      const chrome = getAttr(openingTag, 'chrome') as ArtifactSegment['chrome']

      const closeStart = text.indexOf(CLOSE_TAG, openEnd + 1)

      if (closeStart === -1) {
        segments.push({
          type: 'artifact',
          title,
          layout,
          chrome,
          content: text.slice(openEnd + 1),
        })
        break
      }

      segments.push({
        type: 'artifact',
        title,
        layout,
        chrome,
        content: text.slice(openEnd + 1, closeStart),
      })

      cursor = closeStart + CLOSE_TAG.length
    }
  }

  return segments
}

/** Backwards-compatible alias */
export const parseArtifacts = parseMessage

/** Check if a message contains any rich content tags (start-of-line only) */
export function hasRichContent(text: string): boolean {
  return findTagAtLineStart(text, '<bond-artifact', 0) !== -1
    || findTagAtLineStart(text, '<bond-embed', 0) !== -1
}

/** Backwards-compatible alias */
export const hasArtifacts = hasRichContent
