import { query } from '@anthropic-ai/claude-agent-sdk'

export interface ParsedTodo {
  title: string
  notes: string
  group: string
}

export async function parseTodoInput(raw: string): Promise<ParsedTodo> {
  const trimmed = raw.trim()
  if (!trimmed) return { title: '', notes: '', group: '' }

  // Short single-line inputs don't need AI parsing
  if (!trimmed.includes('\n') && trimmed.length < 60) {
    return { title: trimmed, notes: '', group: '' }
  }

  try {
    const q = query({
      prompt: `Parse this freeform todo input into structured fields. Extract a concise title (the core task, max 80 chars), optional notes (extra context, details, links — keep verbatim), and an optional group/category (1-2 words, lowercase, like "work", "personal", "bond", "design"). If no clear group, leave it empty.

Reply with ONLY valid JSON: {"title": "...", "notes": "...", "group": "..."}

Input:
${trimmed}`,
      options: {
        model: 'haiku',
        allowedTools: [],
        systemPrompt: 'You parse freeform text into structured todo items. Reply with only valid JSON. Be concise with titles. Preserve detail in notes.',
        maxTurns: 1,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'bond-electron/0.1.0'
        } as Record<string, string | undefined>
      } as any
    })

    let resultText = ''
    for await (const message of q) {
      if (message.type === 'result' && message.subtype === 'success') {
        resultText = typeof message.result === 'string' ? message.result : ''
      }
    }

    const jsonMatch = resultText.match(/\{[^}]+\}/)
    if (!jsonMatch) return { title: trimmed, notes: '', group: '' }

    const parsed = JSON.parse(jsonMatch[0]) as ParsedTodo
    return {
      title: (parsed.title || trimmed).slice(0, 120),
      notes: parsed.notes?.slice(0, 2000) || '',
      group: parsed.group?.slice(0, 30) || ''
    }
  } catch {
    // Fallback: first line as title, rest as notes
    const lines = trimmed.split('\n')
    return {
      title: lines[0].slice(0, 120),
      notes: lines.slice(1).join('\n').trim(),
      group: ''
    }
  }
}
