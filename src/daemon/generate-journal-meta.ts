import { query } from '@anthropic-ai/claude-agent-sdk'

export async function generateJournalMeta(
  body: string
): Promise<{ title: string; tags: string[] }> {
  const snippet = body.slice(0, 2000)

  if (!snippet.trim()) {
    return { title: 'Untitled', tags: [] }
  }

  try {
    const q = query({
      prompt: `Generate a short title (2-5 words, no quotes) and 1-4 lowercase tags for this journal entry. Reply with ONLY valid JSON: {"title": "...", "tags": ["..."]}\n\n${snippet}`,
      options: {
        model: 'haiku',
        allowedTools: [],
        systemPrompt: 'You generate short titles and tags for journal entries. Reply with only valid JSON. Tags should be lowercase single words or short hyphenated phrases.',
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
    if (!jsonMatch) return { title: firstLine(body), tags: [] }

    const parsed = JSON.parse(jsonMatch[0]) as { title: string; tags: string[] }
    return {
      title: parsed.title?.slice(0, 60) || firstLine(body),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).toLowerCase().slice(0, 30)).slice(0, 6) : []
    }
  } catch {
    return { title: firstLine(body), tags: [] }
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > 60 ? line.slice(0, 57) + '...' : line || 'Untitled'
}
