import type { TranscriptMessage } from '../../shared/transcript'
import type { CoreMemory, WorkingState } from './types'
import { renderWorkingStateForPrompt } from './working-state'

/**
 * ONE identifier per message, never two. Emitting both `id` (uuid) and `seq`
 * and then asking for "the message ids" is how 93% of rejected sourceIds came
 * to be bare sequence numbers — the model picked the shorter one. `seq` wins:
 * fewer tokens across a 24-message batch, monotonic, and legible in logs. The
 * resolver in observer.ts maps whatever comes back to the canonical uuid.
 */
export function renderTranscriptForMemory(messages: TranscriptMessage[]): string {
  return messages.map(message => {
    const kind = message.kind ? ` kind=${message.kind}` : ''
    const idAttr = message.seq != null ? String(message.seq) : message.id
    const text = message.text?.trim() || renderMessageData(message.data)
    return `<message id="${escapeAttr(idAttr)}" role="${message.role}"${kind}>\n${text}\n</message>`
  }).join('\n\n')
}

function renderMessageData(data: Record<string, unknown> | null | undefined): string {
  if (!data) return ''
  const events = Array.isArray(data.events) ? data.events : []
  const parts: string[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as Record<string, unknown>
    const label = typeof event.label === 'string' ? event.label : undefined
    const output = typeof event.output === 'string' ? event.output.slice(0, 2000) : undefined
    const text = typeof event.text === 'string' ? event.text : undefined
    if (label) parts.push(label)
    if (text) parts.push(text)
    if (output) parts.push(output)
  }
  return parts.join('\n')
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

export function buildObserverPrompt(input: { messages: TranscriptMessage[]; currentState?: WorkingState | null; projectId?: string | null }): string {
  const state = input.currentState ? renderWorkingStateForPrompt(input.currentState) : '(none)'
  return `You are Bond's short-term memory observer. Extract only durable, useful information explicitly supported by the transcript.

Return one JSON object only, no markdown:
{
  "workingState": {
    "goal": "current user goal or empty string",
    "facts": ["short facts needed for the current work"],
    "preferences": ["stable user preferences mentioned or reinforced"],
    "decisions": ["decisions made in this work"],
    "openThreads": ["unresolved follow-ups"],
    "checkpoint": "current position in the active work, or empty string"
  },
  "memories": [
    { "kind": "fact|preference|decision|thread", "text": "one standalone memory", "source": "user|assistant|debrief|system", "projectId": ${JSON.stringify(input.projectId ?? null)}, "tags": ["short-tag"], "confidence": 0.0, "sourceIds": ["message-id"] }
  ]
}

Rules:
- sourceIds must be the id attribute values of the supporting <message> tags, copied exactly.
- Do not invent facts, preferences, decisions, or source ids.
- Prefer fewer, high-signal memories over summaries.
- Keep text standalone and concise.
- Store only durable information explicitly supported by user-authored messages. Assistant statements may provide context but are not evidence of personal facts.
- Preserve explicit user preferences, corrections, decisions, and remember requests.
- Do not infer personal facts from jokes, speculation, hypotheticals, or screen activity.
- Never store credentials, secrets, authentication material, private keys, financial data, or giant code/tool outputs.
- Temporary task details belong in workingState, not durable memories.
- Update checkpoint whenever the user's position in a numbered or staged task changes ("item 8 of 18 filed; next 9").
- Do not write artifacts or activeSkill; Bond captures those from its own tool activity.
- Return no memory rather than manufacturing significance.

Current working state:
${state}

Transcript:
${renderTranscriptForMemory(input.messages)}`
}

export function buildReflectorPrompt(input: { messages: TranscriptMessage[]; coreMemory: CoreMemory; projectId?: string | null }): string {
  return `You are Bond's long-term memory reflector. Distill stable memories from the transcript and update core memory.

Return one JSON object only, no markdown:
{
  "core": { "facts": [], "preferences": [], "decisions": [] },
  "memories": [
    { "kind": "fact|preference|decision|thread", "text": "standalone long-term memory", "source": "user|assistant|debrief|system", "projectId": ${JSON.stringify(input.projectId ?? null)}, "tags": ["short-tag"], "confidence": 0.0, "sourceIds": ["message-id"] }
  ]
}

Rules:
- Return new or updated core items only. Existing core items are preserved automatically; do not repeat them unless rephrasing improves them.
- Core contains only stable identity facts, preferences, corrections, and durable operating rules explicitly supported by user-authored messages.
- sourceIds must be the id attribute values of the supporting <message> tags, copied exactly.
- Do not invent or overgeneralize. If unsure, omit.
- Do not promote temporary work details, Sense observations, jokes, speculation, credentials, secrets, or tool output into core memory.
- Assistant statements are not evidence of personal facts.

Existing core memory:
${JSON.stringify(input.coreMemory, null, 2)}

Transcript:
${renderTranscriptForMemory(input.messages)}`
}

/**
 * Core + working memory — the STABLE half. It changes at most once per
 * observation interval, so it rides the per-request system prompt (rebuilt
 * every turn, never persisted into Pi session history) instead of the context
 * envelope, which is embedded in the user message and accumulates forever.
 * Measured before the split: 14 of 14 user messages in one session carried an
 * envelope, avg 9,146 chars, ~32k tokens of ~90%-identical text in 14 turns.
 */
export function renderStableMemoryState(core: CoreMemory, working?: WorkingState | null): string {
  const sections: string[] = []
  if (core.facts.length || core.preferences.length || core.decisions.length) {
    sections.push(`Core memory:\n${[
      ...core.facts.map(v => `- Fact: ${v}`),
      ...core.preferences.map(v => `- Preference: ${v}`),
      ...core.decisions.map(v => `- Decision: ${v}`),
    ].join('\n')}`)
  }
  if (working) {
    const rendered = renderWorkingStateForPrompt(working)
    if (rendered) sections.push(`Working memory:\n${rendered}`)
  }
  return sections.join('\n\n')
}

/** The VOLATILE half: query-specific retrieval only. Stays in the envelope. */
export function renderMemoryContext(input: { retrieved: Array<{ text: string; score?: number; id?: string }> }): string {
  if (!input.retrieved.length) return ''
  return `Retrieved memory:\n${input.retrieved.map(m => `- ${m.id ? `[${m.id}] ` : ''}${m.text}`).join('\n')}`
}
