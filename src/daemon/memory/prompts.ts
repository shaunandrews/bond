import type { TranscriptMessage } from '../../shared/transcript'
import type { CoreMemory, WorkingState } from './types'
import { renderWorkingStateForPrompt } from './working-state'

export function renderTranscriptForMemory(messages: TranscriptMessage[]): string {
  return messages.map(message => {
    const seq = message.seq != null ? ` seq=${message.seq}` : ''
    const kind = message.kind ? ` kind=${message.kind}` : ''
    const text = message.text?.trim() || renderMessageData(message.data)
    return `<message id="${escapeAttr(message.id)}" role="${message.role}"${kind}${seq}>\n${text}\n</message>`
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
    "openThreads": ["unresolved follow-ups"]
  },
  "memories": [
    { "kind": "fact|preference|decision|thread", "text": "one standalone memory", "source": "user|assistant|debrief|system", "projectId": ${JSON.stringify(input.projectId ?? null)}, "tags": ["short-tag"], "confidence": 0.0, "sourceIds": ["message-id"] }
  ]
}

Rules:
- Use sourceIds from the transcript message ids only.
- Do not invent facts, preferences, decisions, or source ids.
- Prefer fewer, high-signal memories over summaries.
- Keep text standalone and concise.

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
- core arrays should be the complete desired core memory after reflection, not a patch.
- Preserve still-relevant existing core items.
- Use sourceIds from the transcript message ids only.
- Do not invent or overgeneralize. If unsure, omit.

Existing core memory:
${JSON.stringify(input.coreMemory, null, 2)}

Transcript:
${renderTranscriptForMemory(input.messages)}`
}

export function renderMemoryContext(input: { core: CoreMemory; working?: WorkingState | null; retrieved: Array<{ text: string; score?: number; id?: string }> }): string {
  const sections: string[] = []
  if (input.core.facts.length || input.core.preferences.length || input.core.decisions.length) {
    sections.push(`Core memory:\n${[
      ...input.core.facts.map(v => `- Fact: ${v}`),
      ...input.core.preferences.map(v => `- Preference: ${v}`),
      ...input.core.decisions.map(v => `- Decision: ${v}`),
    ].join('\n')}`)
  }
  if (input.working) {
    const rendered = renderWorkingStateForPrompt(input.working)
    if (rendered) sections.push(`Working memory:\n${rendered}`)
  }
  if (input.retrieved.length) {
    sections.push(`Retrieved memory:\n${input.retrieved.map(m => `- ${m.id ? `[${m.id}] ` : ''}${m.text}`).join('\n')}`)
  }
  return sections.join('\n\n')
}
