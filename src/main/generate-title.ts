import Anthropic from '@anthropic-ai/sdk'
import type { SessionMessage } from '../shared/session'

const client = new Anthropic()

export async function generateTitleAndSummary(
  messages: SessionMessage[]
): Promise<{ title: string; summary: string }> {
  const transcript = messages
    .filter((m) => m.role === 'user' || (m.role === 'bond' && m.text))
    .slice(0, 10)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text ?? ''}`)
    .join('\n')

  if (!transcript.trim()) {
    return { title: 'New chat', summary: '' }
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: `Given this conversation, generate a short title (max 6 words) and a one-sentence summary. Reply with ONLY valid JSON: {"title": "...", "summary": "..."}\n\n${transcript}`
        }
      ]
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : ''
    const parsed = JSON.parse(text) as { title: string; summary: string }
    return {
      title: parsed.title?.slice(0, 60) || 'New chat',
      summary: parsed.summary?.slice(0, 200) || ''
    }
  } catch {
    return { title: 'New chat', summary: '' }
  }
}
