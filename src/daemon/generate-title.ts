import { runBondTextQuery } from './agent'
import type { SessionMessage } from '../shared/session'

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
    const resultText = await runBondTextQuery(
      `Generate a short title (2-4 words, no quotes) and a one-sentence summary for this conversation. Reply with ONLY valid JSON: {"title": "...", "summary": "..."}\n\n${transcript}`,
      'haiku'
    )

    // The result might have markdown or extra text — extract JSON
    const jsonMatch = resultText.match(/\{[^}]+\}/)
    if (!jsonMatch) return { title: 'New chat', summary: '' }

    const parsed = JSON.parse(jsonMatch[0]) as { title: string; summary: string }
    return {
      title: parsed.title?.slice(0, 60) || 'New chat',
      summary: parsed.summary?.slice(0, 200) || ''
    }
  } catch {
    return { title: 'New chat', summary: '' }
  }
}
