import { describe, it, expect, vi } from 'vitest'
import { describeDeskState, registerDeskTools, DESK_TOOL_NAMES } from './tools'
import type { DeskStatus } from '../../shared/desk'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

function status(over: Partial<DeskStatus> = {}): DeskStatus {
  return {
    running: true,
    senseState: 'recording',
    senseEnabled: true,
    currentBlock: null,
    presenceSeconds: 0,
    pendingQuestion: null,
    lastAssertionAt: null,
    backfilling: false,
    unresolvedSegments: 0,
    ...over,
  }
}

const blockOn = (name: string): DeskStatus['currentBlock'] => ({
  id: 'b1', threadId: 't1', startedAt: 'x', endedAt: null, presenceSeconds: 4800,
  state: 'candidate', summary: null, reentryNote: null, noteStatus: 'none',
  confidence: 0.9, source: 'inferred', createdAt: 'x', updatedAt: 'x',
  thread: {
    id: 't1', name, normalizedName: name.toLowerCase(), colorSeed: 't1',
    status: 'established', source: 'user', userNote: null, userNoteUpdatedAt: null,
    lastSeenAt: null, archivedAt: null, createdAt: 'x', updatedAt: 'x',
  },
})

/** Minimal ExtensionAPI stand-in that just captures registered tools. */
function fakePi() {
  const tools: Record<string, { execute: (id: string, params: unknown) => Promise<unknown>; description: string; promptGuidelines?: string[] }> = {}
  const pi = {
    registerTool: (tool: { name: string; execute: typeof tools[string]['execute']; description: string; promptGuidelines?: string[] }) => {
      tools[tool.name] = tool
    },
  } as unknown as ExtensionAPI
  return { pi, tools }
}

describe('describeDeskState', () => {
  it('says plainly that Sense is off rather than implying observation', () => {
    const text = describeDeskState(status({ senseEnabled: false, senseState: 'disabled' }))
    expect(text).toContain('Sense is off')
    expect(text).toContain('Enable Sense')
    expect(text).toContain('historical threads and Today only')
  })

  it('reports a paused clock rather than a stopped thread', () => {
    const text = describeDeskState(status({ senseState: 'paused' }))
    expect(text).toContain('paused')
    expect(text).toContain('clock is stopped')
  })

  it('reports back-fill so an empty panel is explainable', () => {
    expect(describeDeskState(status({ backfilling: true }))).toContain('catching up')
  })

  it('gives the current thread with an approximate duration and warns off precision', () => {
    const text = describeDeskState(status({ currentBlock: blockOn('Studio sync dialog'), presenceSeconds: 4800 }))
    expect(text).toContain('Studio sync dialog')
    expect(text).toContain('~1h 20m')
    expect(text).toContain('never quote a precise figure')
  })

  it('says so when there is no thread yet', () => {
    expect(describeDeskState(status())).toContain('No current thread yet')
  })

  it('warns the model off duplicating a pending Ask in prose', () => {
    const text = describeDeskState(status({
      pendingQuestion: {
        id: 'q1', kind: 'thread_switch', blockId: null, proposedThreadId: 't1', itemId: null,
        resourceSignature: null, state: 'pending', presentedAt: null,
        expiresAt: 'x', resolvedAt: null, createdAt: 'x',
        proposedThreadName: 'Studio sync dialog', itemTitle: null,
      },
    }))
    expect(text).toContain('already asking')
    expect(text).toContain('do not ask the same thing in prose')
  })
})

describe('open_desk', () => {
  it('registers under the name the required-tool check expects', () => {
    const { pi, tools } = fakePi()
    registerDeskTools(pi)
    expect(Object.keys(tools)).toEqual(DESK_TOOL_NAMES)
  })

  it('turns Desk on — opening it is explicit intent, the only thing allowed to', async () => {
    const { pi, tools } = fakePi()
    const startRunning = vi.fn()
    registerDeskTools(pi, { startRunning, readStatus: () => status() })

    await tools.open_desk.execute('c1', {})
    expect(startRunning).toHaveBeenCalledWith(true)
  })

  it('emits an open_desk chunk carrying the queued and Sense state', async () => {
    const { pi, tools } = fakePi()
    const onChunk = vi.fn()
    registerDeskTools(pi, {
      onChunk, startRunning: () => {},
      readStatus: () => status({ backfilling: true, senseEnabled: false }),
    })

    await tools.open_desk.execute('c1', {})
    expect(onChunk).toHaveBeenCalledWith({ kind: 'open_desk', queued: true, senseEnabled: false })
  })

  it('returns queued:true so main waits rather than opening an empty panel', async () => {
    const { pi, tools } = fakePi()
    registerDeskTools(pi, { startRunning: () => {}, readStatus: () => status({ backfilling: true }) })

    const result = await tools.open_desk.execute('c1', {}) as { details: { queued: boolean } }
    expect(result.details.queued).toBe(true)
  })

  it('reports the current thread in its details', async () => {
    const { pi, tools } = fakePi()
    registerDeskTools(pi, {
      startRunning: () => {},
      readStatus: () => status({ currentBlock: blockOn('ISP problem') }),
    })

    const result = await tools.open_desk.execute('c1', {}) as { details: { currentThread: string | null } }
    expect(result.details.currentThread).toBe('ISP problem')
  })

  it('a second call reveals the existing panel rather than opening another', async () => {
    const { pi, tools } = fakePi()
    const startRunning = vi.fn()
    registerDeskTools(pi, { startRunning, readStatus: () => status() })

    const first = await tools.open_desk.execute('c1', {}) as { details: { opened: boolean } }
    const second = await tools.open_desk.execute('c2', {}) as { details: { opened: boolean } }
    expect(first.details.opened).toBe(true)
    expect(second.details.opened).toBe(true)
  })

  it('its guidelines forbid grading — no score, streak, or total', () => {
    const { pi, tools } = fakePi()
    registerDeskTools(pi)
    const guidance = (tools.open_desk.promptGuidelines ?? []).join(' ')
    expect(guidance).toContain('never report a productivity score')
    expect(guidance).toContain('approximate')
  })
})
