/**
 * Pure logic for `bond ask`, split out so tests don't trigger the CLI's
 * main() on import (same split as library-helpers.ts).
 */
import type { PendingQuestion, QuestionAnswer, QuestionOption } from '../shared/questions'

export type AskArgs =
  | { mode: 'show' }
  | { mode: 'json' }
  | { mode: 'cancel' }
  | { mode: 'option'; number: number }
  | { mode: 'text'; text: string }

/** Parse `bond ask` argv (after the subcommand itself is stripped). */
export function parseAskArgs(args: string[]): AskArgs {
  if (args.includes('--json')) return { mode: 'json' }
  if (args.includes('--cancel')) return { mode: 'cancel' }
  const textIdx = args.indexOf('--text')
  if (textIdx !== -1) return { mode: 'text', text: args.slice(textIdx + 1).join(' ').trim() }
  const bare = args.find(a => !a.startsWith('--'))
  if (bare && /^\d+$/.test(bare)) return { mode: 'option', number: Number(bare) }
  return { mode: 'show' }
}

/** Resolve a parsed CLI arg against the pending question's options. Null means "fall through to interactive/JSON". */
export function answerFromArgs(parsed: AskArgs, options: QuestionOption[]): QuestionAnswer | null {
  if (parsed.mode === 'cancel') return { kind: 'cancelled' }
  if (parsed.mode === 'text') return parsed.text ? { kind: 'custom', text: parsed.text } : null
  if (parsed.mode === 'option') {
    const option = options.find(o => o.number === parsed.number)
    return option ? { kind: 'option', optionId: option.id, label: option.label, number: option.number } : null
  }
  return null
}

/** The question + numbered options with descriptions, for interactive display. */
export function formatQuestionBlock(pending: PendingQuestion): string {
  const lines: string[] = []
  if (pending.header) lines.push(`[${pending.header}]`)
  lines.push(pending.question)
  for (const opt of pending.options) lines.push(`  ${opt.number}. ${opt.label} — ${opt.description}`)
  return lines.join('\n')
}

/** One line of interactive input → a typed answer. Empty input (incl. Ctrl-C) cancels. */
export function parseAnswerLine(line: string, options: QuestionOption[]): QuestionAnswer {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'cancelled' }
  if (/^\d+$/.test(trimmed)) {
    const option = options.find(o => o.number === Number(trimmed))
    if (option) return { kind: 'option', optionId: option.id, label: option.label, number: option.number }
  }
  return { kind: 'custom', text: trimmed }
}
