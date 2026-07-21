/**
 * Re-entry notes — the feature nobody else has.
 *
 * When you leave a work thread, Bond writes **one line about where you were**,
 * from the Sense text it already has: *"Left at `SyncDialog.tsx` —
 * conflict-state copy unwritten."*
 *
 * The ICSE 2026 TaCoS study had 32 professional developers resume work after
 * gaps of one to seven days. AI-generated context summaries produced the
 * shortest resumption lag and edit lag of any condition and were rated most
 * helpful — but lost on *task success*, because they lacked the forward-looking
 * "what was I about to do" information hand-written notes carried. They also
 * found only the **last 30 minutes** of activity was worth retaining.
 *
 * That is why this runs at departure, in the present tense of the work, from a
 * short lookback — not reconstructed later from a day summary. A note that
 * summarizes instead of orienting ("Worked on Studio for 40 minutes") is the
 * failure mode; "conflict-state copy unwritten" is the product.
 *
 * Privacy: the inputs were already redacted once by Sense, the assembled prompt
 * is redacted again before submission, and the model's answer is redacted
 * before it is persisted. If either pass rejects the content outright, nothing
 * is stored and the note is marked failed.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db'
import { getBlock, getThread, listSegmentsForBlock, recentBlockText, updateBlock } from './store'
import { redactAll, redactField } from './signature'
import type { TextPrompt } from './inference'

/** TaCoS: only the last 30 minutes of activity carried useful context. */
const LOOKBACK_MINUTES = 30
/** Enough to orient, short enough that nobody skims past it. */
const MAX_NOTE_CHARS = 140
const EXCERPT_CHARS = 220
const MAX_EXCERPTS = 6
const PROMPT_TIMEOUT_MS = 120_000

export interface NoteOptions {
  db?: Database.Database
  prompt: TextPrompt
  now?: () => Date
}

export type NoteResult =
  | { status: 'ready'; note: string }
  | { status: 'failed'; reason: 'no_evidence' | 'redacted' | 'model_error' | 'empty'; detail?: string }
  | { status: 'skipped'; reason: 'edited' | 'missing_block' }

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`note generation timed out after ${ms}ms`)), ms)
    timer.unref?.()
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

export interface NoteEvidence {
  threadName: string | null
  files: string[]
  titles: string[]
  excerpts: string[]
}

/**
 * Everything the note is allowed to be written from: the last 30 minutes of
 * linked capture text, plus the files and window titles the segments saw.
 */
export function gatherEvidence(blockId: string, db: Database.Database = getDb()): NoteEvidence {
  const block = getBlock(blockId, db)
  const segments = listSegmentsForBlock(blockId, db)

  const files: string[] = []
  const titles: string[] = []
  for (const segment of segments) {
    for (const path of segment.evidence.paths ?? []) if (!files.includes(path)) files.push(path)
    for (const title of segment.evidence.titles ?? []) if (!titles.includes(title)) titles.push(title)
  }

  const excerpts = recentBlockText(blockId, { minutes: LOOKBACK_MINUTES, limit: MAX_EXCERPTS }, db)
    .map(row => row.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS))
    .filter(Boolean)

  return {
    threadName: block?.threadId ? getThread(block.threadId, db)?.name ?? null : null,
    // Redact again — Sense's rows hold raw titles and paths.
    files: redactAll(files).slice(0, 5),
    titles: redactAll(titles).slice(0, 4),
    excerpts: redactAll(excerpts).slice(0, MAX_EXCERPTS),
  }
}

export function hasEnoughEvidence(evidence: NoteEvidence): boolean {
  return evidence.files.length > 0 || evidence.titles.length > 0 || evidence.excerpts.length > 0
}

export function buildNotePrompt(evidence: NoteEvidence): string {
  const parts: string[] = []
  if (evidence.threadName) parts.push(`Thread: ${evidence.threadName}`)
  if (evidence.files.length) parts.push(`Files open: ${evidence.files.join(', ')}`)
  if (evidence.titles.length) parts.push(`Windows: ${evidence.titles.join(' | ')}`)
  if (evidence.excerpts.length) parts.push(`Recent on-screen text:\n${evidence.excerpts.join('\n---\n')}`)

  return `Someone just stopped working on this. Write ONE short line that will help them pick it back up later.

${parts.join('\n')}

Write the line the way they would to themselves — present tense of the work, naming the specific thing that was mid-flight.

Good: "Left at SyncDialog.tsx — conflict-state copy unwritten."
Good: "Halfway through the retry logic; the timeout case is still unhandled."
Bad: "Worked on Studio for 40 minutes." (summarizes instead of orienting)
Bad: "Made progress on the project." (says nothing)

Rules:
- One line, under ${MAX_NOTE_CHARS} characters. No trailing period required.
- Name a file, a screen, or a decision — something concrete they can re-enter at.
- If the evidence genuinely does not say what was in flight, reply with exactly: UNKNOWN
- Output only the line. No quotes, no prefix, no markdown.`
}

/** Strip the framing a model adds even when told not to. */
export function cleanNote(raw: string): string | null {
  let note = raw.trim()
  if (!note) return null
  note = note.split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
  note = note.replace(/^["'`]|["'`]$/g, '').trim()
  note = note.replace(/^(note|re-?entry note|line)\s*:\s*/i, '').trim()
  if (!note || /^unknown$/i.test(note)) return null
  return note.slice(0, MAX_NOTE_CHARS)
}

/**
 * Write the re-entry note for a departed block.
 *
 * A user edit sets note_status='edited' and is **never** overwritten — that is
 * the whole contract that makes the note safe to edit.
 */
export async function generateReentryNote(
  blockId: string,
  options: NoteOptions
): Promise<NoteResult> {
  const db = options.db ?? getDb()
  const block = getBlock(blockId, db)
  if (!block) return { status: 'skipped', reason: 'missing_block' }
  if (block.noteStatus === 'edited') return { status: 'skipped', reason: 'edited' }

  const evidence = gatherEvidence(blockId, db)
  if (!hasEnoughEvidence(evidence)) {
    updateBlock(blockId, { noteStatus: 'failed' }, db)
    return { status: 'failed', reason: 'no_evidence' }
  }

  const prompt = buildNotePrompt(evidence)
  // Redact the assembled prompt one final time before it leaves the machine.
  const safePrompt = redactField(prompt)
  if (safePrompt === null) {
    updateBlock(blockId, { noteStatus: 'failed' }, db)
    return { status: 'failed', reason: 'redacted' }
  }

  updateBlock(blockId, { noteStatus: 'pending' }, db)

  let raw: string
  try {
    raw = await withTimeout(options.prompt(safePrompt, 'fast'), PROMPT_TIMEOUT_MS)
  } catch (error) {
    updateBlock(blockId, { noteStatus: 'failed' }, db)
    return { status: 'failed', reason: 'model_error', detail: error instanceof Error ? error.message : String(error) }
  }

  const cleaned = cleanNote(raw)
  if (!cleaned) {
    updateBlock(blockId, { noteStatus: 'failed' }, db)
    return { status: 'failed', reason: 'empty' }
  }

  // ...and redact what came back, before it touches the database.
  const safeNote = redactField(cleaned)
  if (safeNote === null) {
    updateBlock(blockId, { noteStatus: 'failed' }, db)
    return { status: 'failed', reason: 'redacted' }
  }

  // A user edit that landed while the model was thinking still wins.
  const current = getBlock(blockId, db)
  if (current?.noteStatus === 'edited') return { status: 'skipped', reason: 'edited' }

  updateBlock(blockId, { reentryNote: safeNote, noteStatus: 'ready' }, db)
  return { status: 'ready', note: safeNote }
}
