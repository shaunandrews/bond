import { describe, expect, it } from 'vitest'
import type { EditMode } from '../../shared/session'
import {
  DEFAULT_POLICY,
  classifyTool,
  decideMcpCall,
  parsePolicy,
  promotedToolName,
  promotionsForEditMode,
  readOnlyToolNames,
  suggestToolClass,
  type McpPolicy,
} from './policy'

function policy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return { ...DEFAULT_POLICY, ...overrides }
}

const FULL: EditMode = { type: 'full' }
const SCOPED: EditMode = { type: 'scoped', allowedPaths: ['/tmp'] }
const READONLY: EditMode = { type: 'readonly' }

describe('parsePolicy', () => {
  it('defaults to ask-everything', () => {
    expect(parsePolicy(undefined)).toEqual(DEFAULT_POLICY)
    expect(parsePolicy('nonsense')).toEqual(DEFAULT_POLICY)
    expect(parsePolicy([])).toEqual(DEFAULT_POLICY)
  })

  it('keeps known trust values and rejects anything else', () => {
    expect(parsePolicy({ trust: 'trusted' }).trust).toBe('trusted')
    expect(parsePolicy({ trust: 'disabled' }).trust).toBe('disabled')
    expect(parsePolicy({ trust: 'yolo' }).trust).toBe('ask')
  })

  it('dedupes and drops junk entries', () => {
    expect(parsePolicy({ read: ['a', 'a', '', 7, null] }).read).toEqual(['a'])
  })

  // A config that lists a tool as both must not end up widening access.
  it('lets the read classification win a contradiction, keeping the tool out of auto-allowed writes', () => {
    const parsed = parsePolicy({ trust: 'trusted', read: ['both'], write: ['both'] })
    expect(parsed.read).toEqual(['both'])
    expect(parsed.write).toEqual([])
  })
})

describe('suggestToolClass', () => {
  it('reads the server annotations as a suggestion only', () => {
    expect(suggestToolClass({ readOnlyHint: true })).toBe('read')
    expect(suggestToolClass({ destructiveHint: true })).toBe('write')
    expect(suggestToolClass({ readOnlyHint: false })).toBe('write')
    expect(suggestToolClass({})).toBe('unknown')
    expect(suggestToolClass(undefined)).toBe('unknown')
  })

  // The whole point: an annotation never classifies a tool by itself.
  it('does not classify a tool on its own', () => {
    expect(classifyTool(policy(), 'anything')).toBe('unknown')
  })
})

describe('decideMcpCall', () => {
  it('blocks everything on a disabled server, in every mode', () => {
    for (const editMode of [FULL, SCOPED, READONLY]) {
      const decision = decideMcpCall({ editMode, policy: policy({ trust: 'disabled', read: ['search'] }), toolName: 'search' })
      expect(decision).toMatchObject({ kind: 'block' })
    }
  })

  // The default policy reproduces M1 exactly: prompt for everything.
  it('asks for every call on a fresh server', () => {
    expect(decideMcpCall({ editMode: FULL, policy: policy(), toolName: 'anything' }).kind).toBe('ask')
    expect(decideMcpCall({ editMode: SCOPED, policy: policy(), toolName: 'anything' }).kind).toBe('ask')
  })

  it('asks even for a confirmed read while trust is still "ask"', () => {
    expect(decideMcpCall({ editMode: FULL, policy: policy({ read: ['search'] }), toolName: 'search' }).kind).toBe('ask')
  })

  describe('readonly sessions', () => {
    it('allows a confirmed read-only tool', () => {
      expect(decideMcpCall({ editMode: READONLY, policy: policy({ read: ['search'] }), toolName: 'search' }).kind).toBe('allow')
    })

    it('blocks writes and unclassified tools', () => {
      expect(decideMcpCall({ editMode: READONLY, policy: policy({ write: ['post'] }), toolName: 'post' })).toMatchObject({ kind: 'block' })
      expect(decideMcpCall({ editMode: READONLY, policy: policy(), toolName: 'mystery' })).toMatchObject({ kind: 'block' })
    })

    it('still asks for a read flagged always-ask', () => {
      expect(decideMcpCall({ editMode: READONLY, policy: policy({ read: ['search'], alwaysAsk: ['search'] }), toolName: 'search' }).kind).toBe('ask')
    })

    it('ignores trust: a trusted server cannot write in a read-only session', () => {
      expect(decideMcpCall({ editMode: READONLY, policy: policy({ trust: 'trusted', write: ['post'] }), toolName: 'post' })).toMatchObject({ kind: 'block' })
    })
  })

  describe('trusted servers', () => {
    const trusted = (overrides: Partial<McpPolicy> = {}) => policy({ trust: 'trusted', read: ['search'], write: ['post'], ...overrides })

    it('auto-allows confirmed reads in scoped and full', () => {
      expect(decideMcpCall({ editMode: FULL, policy: trusted(), toolName: 'search' }).kind).toBe('allow')
      expect(decideMcpCall({ editMode: SCOPED, policy: trusted(), toolName: 'search' }).kind).toBe('allow')
    })

    it('auto-allows confirmed writes in full but prompts in scoped', () => {
      expect(decideMcpCall({ editMode: FULL, policy: trusted(), toolName: 'post' }).kind).toBe('allow')
      expect(decideMcpCall({ editMode: SCOPED, policy: trusted(), toolName: 'post' }).kind).toBe('ask')
    })

    it('always prompts for an unclassified tool', () => {
      expect(decideMcpCall({ editMode: FULL, policy: trusted(), toolName: 'mystery' }).kind).toBe('ask')
    })

    it('honours always-ask over trust', () => {
      expect(decideMcpCall({ editMode: FULL, policy: trusted({ alwaysAsk: ['search'] }), toolName: 'search' }).kind).toBe('ask')
      expect(decideMcpCall({ editMode: FULL, policy: trusted({ alwaysAsk: ['post'] }), toolName: 'post' }).kind).toBe('ask')
    })
  })
})

describe('readOnlyToolNames', () => {
  it('lists confirmed reads', () => {
    expect(readOnlyToolNames(policy({ read: ['a', 'b'] }))).toEqual(['a', 'b'])
  })

  it('is empty for a disabled server', () => {
    expect(readOnlyToolNames(policy({ trust: 'disabled', read: ['a'] }))).toEqual([])
  })
})

describe('promotedToolName', () => {
  it('namespaces the Pi tool name and sanitizes both halves', () => {
    expect(promotedToolName('context-a8c', 'search_p2')).toBe('mcp__context_a8c__search_p2')
    expect(promotedToolName('srv', 'weird.tool-name')).toBe('mcp__srv__weird_tool_name')
  })

  it('cannot collide with Bond\'s own tool names', () => {
    expect(promotedToolName('a', 'b').startsWith('mcp__')).toBe(true)
  })
})

describe('promotionsForEditMode', () => {
  const servers = [
    { id: 'a8c', enabled: true, policy: policy({ read: ['search'], write: ['post'], promoted: ['search', 'post'] }) },
    { id: 'off', enabled: false, policy: policy({ promoted: ['hidden'] }) },
    { id: 'never', enabled: true, policy: policy({ trust: 'disabled', promoted: ['nope'] }) },
  ]

  it('exposes pinned tools from enabled, non-disabled servers', () => {
    expect(promotionsForEditMode(servers, FULL).map((target) => target.piName))
      .toEqual(['mcp__a8c__search', 'mcp__a8c__post'])
  })

  // A promoted tool the gate would block must not be advertised at all.
  it('exposes only confirmed reads in a readonly session', () => {
    expect(promotionsForEditMode(servers, READONLY).map((target) => target.tool)).toEqual(['search'])
  })

  it('is empty when nothing is pinned', () => {
    expect(promotionsForEditMode([{ id: 'a8c', enabled: true, policy: policy() }], FULL)).toEqual([])
  })
})
