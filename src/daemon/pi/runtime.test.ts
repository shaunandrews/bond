import { describe, expect, it } from 'vitest'
import { ONBOARDING_STAGE_TOOLS } from '../onboarding'
import { activateRequestedTools, composePromptWithContext, contextUsageFromSession, piEventToChunks, shouldFlushDeferredPanel, textBlockSeparator, toolsForEditMode } from './runtime'
import { IMAGEGEN_TOOL_NAMES } from '../imagegen'
import { MEMORY_TOOL_NAMES } from '../memory/tools'
import { WEB_TOOL_NAMES } from '../web/tools'

describe('piEventToChunks', () => {
  it('preserves renderer text and thinking chunks', () => {
    expect(piEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }))
      .toEqual([{ kind: 'assistant_text', text: 'Hello' }])
    expect(piEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm' } }))
      .toEqual([{ kind: 'thinking_text', text: 'Hmm' }])
  })

  it('maps Pi tool lifecycle events to Bond chunks', () => {
    expect(piEventToChunks({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'call-1', args: { path: '/tmp/a.txt' } }))
      .toEqual([{ kind: 'assistant_tool', name: 'read', summary: '/tmp/a.txt', input: { path: '/tmp/a.txt' }, toolUseId: 'call-1' }])
    expect(piEventToChunks({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'call-1', result: 'contents', isError: false }))
      .toEqual([{ kind: 'tool_result', toolName: 'read', toolUseId: 'call-1', output: 'contents', isError: false }])
  })

  it('strips base64 image payloads from tool result previews', () => {
    const result = {
      content: [
        { type: 'text', text: 'Generated image.' },
        { type: 'image', data: 'x'.repeat(10_000), mimeType: 'image/png' },
      ],
    }
    const [chunk] = piEventToChunks({ type: 'tool_execution_end', toolName: 'codex_generate_image', toolCallId: 'call-2', result, isError: false })
    expect(chunk.kind).toBe('tool_result')
    if (chunk.kind !== 'tool_result') return
    expect(chunk.output).toContain('Generated image.')
    expect(chunk.output).toContain('[image/png omitted]')
    expect(chunk.output).not.toContain('xxxxxxxxxx')
  })

  it('maps retry status and ignores unrelated events', () => {
    expect(piEventToChunks({ type: 'auto_retry_start', errorMessage: 'rate limited' }))
      .toEqual([{ kind: 'system', subtype: 'api_retry', text: 'rate limited' }])
    expect(piEventToChunks({ type: 'agent_start' })).toEqual([])
  })
})

describe('activateRequestedTools', () => {
  it('replaces a resumed session tool set after extensions register', () => {
    let active = ['read', 'grep']
    const session = {
      getAllTools: () => [...['read', 'grep', ...MEMORY_TOOL_NAMES].map(name => ({ name }))],
      setActiveToolsByName: (names: string[]) => { active = names },
    }

    const requested = ['read', ...MEMORY_TOOL_NAMES]
    expect(activateRequestedTools(session, requested)).toEqual(requested)
    expect(active).toEqual(requested)
  })
})

describe('textBlockSeparator', () => {
  // Regression: Pi streams text blocks bare, so a block starting after
  // earlier prose (post-tool continuation) rendered as "…the chat.One of…".
  it('inserts a paragraph break before a text block that follows earlier prose', () => {
    expect(textBlockSeparator({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }, true))
      .toEqual({ kind: 'assistant_text', text: '\n\n' })
  })

  it('stays silent for the first block of the turn and for non-text events', () => {
    expect(textBlockSeparator({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }, false)).toBeNull()
    expect(textBlockSeparator({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }, true)).toBeNull()
    expect(textBlockSeparator({ type: 'tool_execution_start', toolName: 'read' }, true)).toBeNull()
  })
})

describe('shouldFlushDeferredPanel', () => {
  // Regression: a show_panel call deferred for arriving before any prose must
  // still open at turn end — the model was told not to retry, so if the
  // runtime drops it too, the beat announces a panel that never appears.
  it('opens the deferred panel once narration was delivered', () => {
    expect(shouldFlushDeferredPanel('sense', true, false)).toBe('sense')
  })

  it('stays closed without narration, without a deferral, or after an abort', () => {
    expect(shouldFlushDeferredPanel('sense', false, false)).toBeNull()
    expect(shouldFlushDeferredPanel(null, true, false)).toBeNull()
    expect(shouldFlushDeferredPanel('sense', true, true)).toBeNull()
  })
})

describe('toolsForEditMode', () => {
  it('keeps Bond memory tools active in every workspace permission mode', () => {
    for (const mode of [{ type: 'full' as const }, { type: 'readonly' as const }, { type: 'scoped' as const, allowedPaths: ['/tmp'] }]) {
      expect(toolsForEditMode(mode)).toEqual(expect.arrayContaining([...MEMORY_TOOL_NAMES]))
    }
  })

  it('keeps Bond web tools active in every workspace permission mode', () => {
    for (const mode of [{ type: 'full' as const }, { type: 'readonly' as const }, { type: 'scoped' as const, allowedPaths: ['/tmp'] }]) {
      expect(toolsForEditMode(mode)).toEqual(expect.arrayContaining([...WEB_TOOL_NAMES]))
    }
  })

  it('allowlists the Codex image tool in every mode, but only with a connected subscription', () => {
    for (const mode of [{ type: 'full' as const }, { type: 'readonly' as const }, { type: 'scoped' as const, allowedPaths: ['/tmp'] }]) {
      expect(toolsForEditMode(mode, 'completed', { imageGen: true })).toEqual(expect.arrayContaining([...IMAGEGEN_TOOL_NAMES]))
      for (const tool of IMAGEGEN_TOOL_NAMES) {
        expect(toolsForEditMode(mode)).not.toContain(tool)
        expect(toolsForEditMode(mode, 'completed', { imageGen: false })).not.toContain(tool)
      }
    }
  })

  // Regression: the extension registered complete_onboarding, but the tool was
  // missing from this allowlist, so activateRequestedTools() deactivated it —
  // the agent could never mark the interview finished no matter what the
  // prompt said. Each onboarding stage exposes exactly its own tools.
  it('allowlists onboarding tools per stage in every mode', () => {
    for (const mode of [{ type: 'full' as const }, { type: 'readonly' as const }, { type: 'scoped' as const, allowedPaths: ['/tmp'] }]) {
      // The pending stage carries the tour tools too: the tour's first beat
      // runs in the SAME turn complete_onboarding flips the status, and Pi
      // activates tools only once per turn.
      const pending = toolsForEditMode(mode, 'pending')
      for (const tool of [...ONBOARDING_STAGE_TOOLS.pending, ...ONBOARDING_STAGE_TOOLS.education]) {
        expect(pending).toContain(tool)
      }

      const education = toolsForEditMode(mode, 'education')
      for (const tool of ONBOARDING_STAGE_TOOLS.education) expect(education).toContain(tool)
      expect(education).not.toContain('complete_onboarding')

      for (const done of ['completed', 'skipped', 'existing-user'] as const) {
        const tools = toolsForEditMode(mode, done)
        for (const tool of [...ONBOARDING_STAGE_TOOLS.pending, ...ONBOARDING_STAGE_TOOLS.education]) {
          expect(tools).not.toContain(tool)
        }
      }
      expect(toolsForEditMode(mode)).not.toContain('complete_onboarding')
    }
  })
})

describe('composePromptWithContext', () => {
  it('places the bounded context envelope before each user request', () => {
    expect(composePromptWithContext('Do work', '  <bond-context-envelope>ctx</bond-context-envelope>  '))
      .toBe('<bond-context-envelope>ctx</bond-context-envelope>\n\n<current-user-request>\nDo work\n</current-user-request>')
    expect(composePromptWithContext('Do work')).toBe('Do work')
  })
})

describe('contextUsageFromSession', () => {
  it('normalizes Pi context usage for turn completion', () => {
    expect(contextUsageFromSession({ getContextUsage: () => ({ tokens: 42, contextWindow: 1000 }) }))
      .toEqual({ contextTokens: 42, contextWindow: 1000 })
    expect(contextUsageFromSession({ getContextUsage: () => ({ tokens: null, contextWindow: 1000 }) }))
      .toEqual({ contextTokens: null, contextWindow: 1000 })
    expect(contextUsageFromSession({})).toEqual({ contextTokens: null, contextWindow: null })
  })
})
