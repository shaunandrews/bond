import { runBondTextQuery } from './agent'
import type { SessionMessage } from '../shared/session'
import type { SessionDebrief } from '../shared/sense'
import { getMessages, getSession } from './sessions'
import { getDb } from './db'
import { randomUUID } from 'node:crypto'

/**
 * Generate a structured debrief for an archived session using Bond's balanced tier.
 * Non-blocking — errors are logged and swallowed, never propagated.
 */
export async function generateDebrief(sessionId: string): Promise<SessionDebrief | null> {
  const session = getSession(sessionId)
  if (!session) {
    console.warn(`[bond] debrief skipped: session ${sessionId} not found`)
    return null
  }

  const messages = getMessages(sessionId)

  // Count substantive messages (user/bond with text, excluding image-only)
  const substantive = messages.filter(
    m => (m.role === 'user' || m.role === 'bond') && m.text
  )
  if (substantive.length < 3) {
    return null
  }

  // Build transcript — cap at 50 messages, truncate middle if needed
  let transcript: string
  if (substantive.length <= 50) {
    transcript = formatTranscript(substantive)
  } else {
    const first = substantive.slice(0, 25)
    const last = substantive.slice(-25)
    transcript = formatTranscript(first) +
      '\n[... middle of conversation truncated ...]\n' +
      formatTranscript(last)
  }

  // Cap transcript at ~15k chars (~4k tokens)
  if (transcript.length > 15000) {
    transcript = transcript.slice(0, 7500) +
      '\n[... truncated ...]\n' +
      transcript.slice(-7500)
  }

  const prompt = buildPrompt(transcript)

  // Try generation, retry once on parse failure
  let parsed = await callBalanced(prompt)
  if (!parsed) {
    // Retry with shorter prompt
    const shortTranscript = transcript.slice(0, 5000)
    parsed = await callBalanced(buildPrompt(shortTranscript))
  }

  if (!parsed) {
    console.warn(`[bond] debrief degraded for session ${sessionId}: parse failed after retry`)
    // Store degraded debrief with summary only
    parsed = {
      summary: `Session "${session.title}" with ${substantive.length} messages.`,
      topics: [],
    }
  }

  // Calculate duration from session timestamps (messages table lacks created_at)
  const db = getDb()
  let durationSeconds = 0

  const sessionRow = db.prepare(
    'SELECT created_at, updated_at FROM sessions WHERE id = ?'
  ).get(sessionId) as { created_at: string; updated_at: string } | undefined
  if (sessionRow) {
    const start = new Date(sessionRow.created_at).getTime()
    const end = new Date(sessionRow.updated_at || sessionRow.created_at).getTime()
    durationSeconds = Math.max(0, Math.round((end - start) / 1000))
  }

  const now = new Date().toISOString()
  const debrief: SessionDebrief = {
    id: randomUUID(),
    sessionId,
    sessionTitle: session.title,
    summary: parsed.summary,
    topics: parsed.topics,
    messageCount: substantive.length,
    durationSeconds,
    createdAt: now,
  }

  // If debrief already exists for this session, delete it first (FTS triggers fire cleanly)
  const existing = db.prepare('SELECT id FROM sense_debriefs WHERE session_id = ?').get(sessionId) as { id: string } | undefined
  if (existing) {
    db.prepare('DELETE FROM sense_debriefs WHERE id = ?').run(existing.id)
  }

  // Insert debrief with flattened _text fields
  db.prepare(`
    INSERT INTO sense_debriefs (
      id, session_id, session_title,
      summary, topics, decisions, open_threads, key_facts,
      topics_text, decisions_text, open_threads_text, key_facts_text,
      message_count, duration_seconds, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    debrief.id, debrief.sessionId, debrief.sessionTitle,
    debrief.summary,
    JSON.stringify(debrief.topics),
    '[]',
    '[]',
    '[]',
    debrief.topics.join(' '),
    '',
    '',
    '',
    debrief.messageCount, debrief.durationSeconds, debrief.createdAt
  )

  console.log(`[bond] debrief generated for "${session.title}" (${substantive.length} messages)`)
  return debrief
}

/**
 * Backfill debriefs for archived sessions that don't have one.
 */
export async function backfillDebriefs(limit = 50): Promise<{ generated: number; skipped: number; failed: number }> {
  const db = getDb()
  const sessions = db.prepare(`
    SELECT s.id, s.title
    FROM sessions s
    WHERE s.archived = 1
    AND s.id NOT IN (SELECT session_id FROM sense_debriefs WHERE session_id IS NOT NULL)
    AND (
      SELECT COUNT(*) FROM messages
      WHERE session_id = s.id AND role IN ('user', 'bond') AND text IS NOT NULL
    ) >= 3
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit) as { id: string; title: string }[]

  let generated = 0, failed = 0

  for (const session of sessions) {
    try {
      const result = await generateDebrief(session.id)
      if (result) generated++
    } catch (err: any) {
      console.warn(`[bond] backfill failed for session ${session.id}:`, err.message)
      failed++
    }
    // Rate limit — 2s between background model calls
    await new Promise(r => setTimeout(r, 2000))
  }

  const skipped = sessions.length - generated - failed
  return { generated, skipped, failed }
}

// --- Internal helpers ---

function formatTranscript(messages: SessionMessage[]): string {
  return messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text ?? ''}`)
    .join('\n')
}

function buildPrompt(transcript: string): string {
  return `Analyze this conversation and produce a structured debrief. Reply with ONLY valid JSON.

The JSON must have these fields:
- "summary": 2-3 sentence overview of what happened
- "topics": array of tag-like topic labels (e.g. "memory-system", "css-layout", "bug-fix")

If the session is trivial, still provide a concise summary and use an empty topics array if no clear labels apply.

Conversation:
${transcript}

Reply with ONLY valid JSON, no markdown fences:`
}

interface ParsedDebrief {
  summary: string
  topics: string[]

}

async function callBalanced(prompt: string): Promise<ParsedDebrief | null> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('debrief timeout')), 30000)
    )
    const resultText = await Promise.race([runBondTextQuery(prompt, 'balanced'), timeout])

    if (!resultText) return null

    // Extract JSON from response
    const jsonMatch = resultText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    // Validate structure
    if (typeof parsed.summary !== 'string') return null
    if (!Array.isArray(parsed.topics)) parsed.topics = []
    // Ensure all array items are strings
    parsed.topics = parsed.topics.filter((t: unknown) => typeof t === 'string')

    return parsed as ParsedDebrief
  } catch (err: any) {
    console.warn('[bond] debrief Pi call failed:', err.message)
    return null
  }
}
