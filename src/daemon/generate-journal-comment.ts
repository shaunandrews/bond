import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { getSoul } from './settings'
import { getSkillsDir } from './paths'

export async function generateBondComment(entryBody: string, entryTitle: string): Promise<string> {
  const cwd = homedir()
  const soul = getSoul().trim()

  let systemPrompt =
    'You are Bond, a standalone desktop assistant app for Mac. ' +
    'You are responding to a journal entry written by your user. ' +
    'Be real — agree, push back, add context, make connections to what you know about their work. ' +
    'Keep it concise (1-3 paragraphs). Write as yourself, not as a generic AI. ' +
    'You have access to tools — use them to gather context if it helps you give a better response. ' +
    'Do NOT write JSON, do NOT use markdown headers. Just write your response as plain prose.'

  if (soul) {
    systemPrompt += `\n\n<soul>\n${soul}\n</soul>`
  }

  const prompt =
    `The user wrote this journal entry titled "${entryTitle}":\n\n---\n${entryBody}\n---\n\n` +
    `Use /familiar to recall what you know about what they've been working on and what's been happening, ` +
    `then respond with your perspective on what they wrote.`

  try {
    const q = query({
      prompt,
      options: {
        model: 'sonnet',
        cwd,
        tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash'],
        allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash'],
        systemPrompt,
        permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'allow' as const }),
        plugins: [
          { type: 'local', path: resolve(getSkillsDir(), '..') }
        ],
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

    return resultText.trim() || 'I read your entry but couldn\'t formulate a response.'
  } catch (e) {
    console.error('[bond] generateBondComment error:', e instanceof Error ? e.message : String(e))
    return 'I tried to respond but hit an error. Try again later.'
  }
}
