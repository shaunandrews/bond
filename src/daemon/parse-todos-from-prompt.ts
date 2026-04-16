import { query } from '@anthropic-ai/claude-agent-sdk'

export interface ParsedTodo {
  title: string
  notes: string
  group: string
}

export async function parseTodosFromPrompt(
  prompt: string,
  existingGroups: string[] = []
): Promise<ParsedTodo[]> {
  const trimmed = prompt.trim()
  if (!trimmed) return []

  const groupsHint = existingGroups.length
    ? `Prefer existing groups if applicable: ${existingGroups.join(', ')}.`
    : ''

  try {
    const result = await Promise.race([
      runQuery(trimmed, groupsHint),
      timeout(8000)
    ])
    return result
  } catch {
    // AI call failed or timed out — return empty so composable falls back to literal
    return []
  }
}

async function runQuery(prompt: string, groupsHint: string): Promise<ParsedTodo[]> {
  const q = query({
    prompt,
    options: {
      model: 'haiku',
      allowedTools: [],
      systemPrompt: `You create todos from natural language. The user describes what they need and you extract structured todos.

Rules:
- Return a JSON array: [{"title": "...", "notes": "...", "group": "..."}]
- Title: concise action item (max 80 chars). Start with a verb.
- Notes: additional context, details, or links. Keep verbatim from user input.
- Group: 1-2 word category (lowercase). ${groupsHint} Only set if clearly implied.
- Create multiple todos if the user describes multiple distinct tasks.
- Return at most 5 todos. If the input implies more, consolidate.
- If the input is not a task or action item, return an empty array [].
- Preserve the user's language.

Examples:
- "review the PR and leave comments" → 1 todo (same workflow)
- "review the PR for auth and also fix the typo on the landing page" → 2 todos (unrelated tasks)
- "I need to update the docs, write tests, and deploy to staging" → 3 todos (distinct actions)
- "set up CI/CD pipeline" → 1 todo (even though it involves multiple steps)
- "thanks" → [] (not a task)

Reply with ONLY the JSON array. No markdown fences, no explanation.`,
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

  return parseJsonArray(resultText)
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
}

/** Parse the AI response into a ParsedTodo[]. Handles markdown fences, malformed JSON. */
function parseJsonArray(text: string): ParsedTodo[] {
  if (!text) return []

  // Strip markdown code fences if present
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '')

  try {
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return sanitizeArray(parsed)
  } catch {
    // Last resort: try to find a JSON array in the response
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      try {
        const arr = JSON.parse(match[0])
        if (Array.isArray(arr)) return sanitizeArray(arr)
      } catch { /* give up */ }
    }
    return []
  }
}

function sanitizeArray(arr: unknown[]): ParsedTodo[] {
  return arr
    .slice(0, 5)
    .map(item => {
      const obj = item as Record<string, unknown>
      return {
        title: String(obj.title || '').slice(0, 120),
        notes: String(obj.notes || '').slice(0, 2000),
        group: String(obj.group || '').slice(0, 30),
      }
    })
    .filter(t => t.title.length > 0)
}
