import { describe, expect, it, vi } from 'vitest'
import type { BondStreamChunk } from '../../shared/stream'
import { QUESTION_TOOL_NAMES, createQuestionExtensionFactory, registerQuestionTools, type QuestionToolOptions } from './tools'
import { resolveQuestion, pendingQuestionTurnIds } from '../questions'

interface RegisteredToolDef {
  name: string
  execute: (toolCallId: string, params: Record<string, any>, signal?: AbortSignal) => Promise<{ content: { type: string; text: string }[]; details: any }>
}

function collectTools(options: QuestionToolOptions = {}): Map<string, RegisteredToolDef> {
  const tools = new Map<string, RegisteredToolDef>()
  registerQuestionTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, options)
  return tools
}

const BASE_PARAMS = {
  question: 'Which approach?',
  options: [
    { label: 'Balanced (Recommended)', description: 'Middle ground' },
    { label: 'Aggressive', description: 'Faster but riskier' },
  ],
}

describe('registerQuestionTools', () => {
  it('registers exactly the exported tool names, and the factory matches', () => {
    expect([...collectTools().keys()]).toEqual(QUESTION_TOOL_NAMES)
    const names: string[] = []
    createQuestionExtensionFactory()({ registerTool: (def: any) => names.push(def.name) } as any)
    expect(names).toEqual(QUESTION_TOOL_NAMES)
  })

  it('emits a user_question chunk with daemon-minted, numbered options', async () => {
    const chunks: BondStreamChunk[] = []
    const tool = collectTools({ turnId: 'turn-1', onChunk: (c) => chunks.push(c) }).get('ask_user_question')!

    const pending = tool.execute('call-1', BASE_PARAMS)
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0] as Extract<BondStreamChunk, { kind: 'user_question' }>
    expect(chunk.kind).toBe('user_question')
    expect(chunk.question).toBe('Which approach?')
    expect(chunk.options).toEqual([
      { id: `${chunk.questionId}:0`, number: 1, label: 'Balanced (Recommended)', description: 'Middle ground' },
      { id: `${chunk.questionId}:1`, number: 2, label: 'Aggressive', description: 'Faster but riskier' },
    ])
    expect(pendingQuestionTurnIds()).toContain('turn-1')

    resolveQuestion(chunk.questionId, { kind: 'option', optionId: chunk.options[0].id, label: chunk.options[0].label, number: 1 })
    await pending
  })

  it('resolves an option answer with the description folded into the result text', async () => {
    const chunks: BondStreamChunk[] = []
    const tool = collectTools({ turnId: 'turn-1', onChunk: (c) => chunks.push(c) }).get('ask_user_question')!

    const pending = tool.execute('call-1', BASE_PARAMS)
    const chunk = chunks[0] as Extract<BondStreamChunk, { kind: 'user_question' }>
    resolveQuestion(chunk.questionId, { kind: 'option', optionId: chunk.options[0].id, label: chunk.options[0].label, number: 1 })

    const result = await pending
    expect(result.content[0].text).toBe('User selected option 1: Balanced (Recommended) — Middle ground')
    expect(result.details).toEqual({ kind: 'option', optionId: chunk.options[0].id, label: chunk.options[0].label, number: 1 })
  })

  it('resolves a custom answer', async () => {
    const chunks: BondStreamChunk[] = []
    const tool = collectTools({ turnId: 'turn-1', onChunk: (c) => chunks.push(c) }).get('ask_user_question')!

    const pending = tool.execute('call-1', BASE_PARAMS)
    const chunk = chunks[0] as Extract<BondStreamChunk, { kind: 'user_question' }>
    resolveQuestion(chunk.questionId, { kind: 'custom', text: 'actually, do X instead' })

    const result = await pending
    expect(result.content[0].text).toBe('User wrote a custom answer: actually, do X instead')
  })

  it('resolves a cancelled answer without throwing', async () => {
    const chunks: BondStreamChunk[] = []
    const tool = collectTools({ turnId: 'turn-1', onChunk: (c) => chunks.push(c) }).get('ask_user_question')!

    const pending = tool.execute('call-1', BASE_PARAMS)
    const chunk = chunks[0] as Extract<BondStreamChunk, { kind: 'user_question' }>
    resolveQuestion(chunk.questionId, { kind: 'cancelled' })

    const result = await pending
    expect(result.content[0].text).toContain('Do not ask again')
    expect(result.details).toEqual({ kind: 'cancelled' })
  })

  it('resolves as cancelled when the abort signal fires', async () => {
    const chunks: BondStreamChunk[] = []
    const controller = new AbortController()
    const tool = collectTools({ turnId: 'turn-1', onChunk: (c) => chunks.push(c) }).get('ask_user_question')!

    const pending = tool.execute('call-1', BASE_PARAMS, controller.signal)
    controller.abort()

    const result = await pending
    expect(result.details).toEqual({ kind: 'cancelled' })
  })
})
