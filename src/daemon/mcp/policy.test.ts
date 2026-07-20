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
  routeKeyFor,
  routeSpecFromSchema,
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

    // Full mode is a standing approval for Bond's OWN workspace tools, where
    // the blast radius is this machine. An MCP write lands in someone else's
    // system with no undo, so trust buys silence on reads only.
    it('still prompts for a confirmed write in every mode', () => {
      expect(decideMcpCall({ editMode: FULL, policy: trusted(), toolName: 'post' }).kind).toBe('ask')
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

// The real context-a8c execute-tool schema: provider + subtool select the
// operation, subtool_args is the payload, and `tool`/`params` are legacy
// aliases the model may use instead.
const EXECUTE_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string', description: 'The provider name' },
    subtool: { type: 'string', description: 'The sub-tool name within the provider' },
    subtool_args: { type: 'object', description: 'Arguments to pass to the sub-tool' },
    tool: { type: 'string', description: 'Legacy alias for `subtool`. Prefer `subtool` for new code.' },
    params: { type: 'object', description: 'Legacy alias for `subtool_args`.' },
  },
  required: ['provider'],
}

describe('routeSpecFromSchema', () => {
  it('routes a proxy tool on its leading string arguments', () => {
    expect(routeSpecFromSchema(EXECUTE_SCHEMA).map((s) => s.name)).toEqual(['provider', 'subtool'])
  })

  // Missing this is a real bypass: a rule on linear/create-issue would not
  // see a call that spelled it `tool: 'create-issue'`.
  it('binds a legacy alias to the segment it stands in for', () => {
    expect(routeSpecFromSchema(EXECUTE_SCHEMA)[1].aliases).toEqual(['tool'])
  })

  it('routes a single-argument tool on that argument', () => {
    const schema = { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] }
    expect(routeSpecFromSchema(schema).map((s) => s.name)).toEqual(['provider'])
  })

  // An ordinary tool must keep behaving exactly as it did before routing.
  it('routes nothing for a tool with no string arguments', () => {
    expect(routeSpecFromSchema({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } })).toEqual([])
    expect(routeSpecFromSchema({ type: 'object' })).toEqual([])
    expect(routeSpecFromSchema(undefined)).toEqual([])
    expect(routeSpecFromSchema('nonsense')).toEqual([])
  })
})

describe('routeKeyFor', () => {
  const spec = routeSpecFromSchema(EXECUTE_SCHEMA)

  it('builds the route from the call arguments', () => {
    expect(routeKeyFor(spec, { provider: 'linear', subtool: 'search' })).toBe('linear/search')
  })

  it('resolves a legacy alias to the same route', () => {
    expect(routeKeyFor(spec, { provider: 'linear', tool: 'create-issue' })).toBe('linear/create-issue')
  })

  it('stops at the first missing segment', () => {
    expect(routeKeyFor(spec, { provider: 'linear' })).toBe('linear')
    expect(routeKeyFor(spec, { subtool: 'search' })).toBeNull()
    expect(routeKeyFor(spec, {})).toBeNull()
    expect(routeKeyFor(spec, undefined)).toBeNull()
  })

  it('is null for a tool that does not route', () => {
    expect(routeKeyFor([], { anything: 'here' })).toBeNull()
  })
})

describe('classifyTool with routes', () => {
  const withRules = (overrides: Partial<McpPolicy>) => policy(overrides)

  it('matches the most specific rule', () => {
    const p = withRules({ read: ['exec:linear'], write: ['exec:linear/create-issue'] })

    expect(classifyTool(p, 'exec', 'linear/search')).toBe('read')
    expect(classifyTool(p, 'exec', 'linear/create-issue')).toBe('write')
  })

  it('falls back from route to a blanket tool rule', () => {
    const p = withRules({ read: ['exec'] })
    expect(classifyTool(p, 'exec', 'linear/search')).toBe('read')
  })

  it('does not leak one provider\'s rule to another', () => {
    const p = withRules({ read: ['exec:mgs'] })

    expect(classifyTool(p, 'exec', 'mgs/search')).toBe('read')
    expect(classifyTool(p, 'exec', 'linear/search')).toBe('unknown')
  })

  it('keeps plain tool-name classification working', () => {
    expect(classifyTool(policy({ read: ['search_p2'] }), 'search_p2')).toBe('read')
  })
})

describe('decideMcpCall with routes', () => {
  const trusted = (overrides: Partial<McpPolicy> = {}) => policy({ trust: 'trusted', ...overrides })

  // The whole point of the exercise.
  it('runs a trusted read route silently while its sibling write still asks', () => {
    const p = trusted({ read: ['exec:linear/search'], write: ['exec:linear/create-issue'] })

    for (const editMode of [FULL, SCOPED]) {
      expect(decideMcpCall({ editMode, policy: p, toolName: 'exec', route: 'linear/search' }).kind).toBe('allow')
      expect(decideMcpCall({ editMode, policy: p, toolName: 'exec', route: 'linear/create-issue' }).kind).toBe('ask')
    }
  })

  it('asks for an unclassified sibling of a trusted route', () => {
    const p = trusted({ read: ['exec:linear/search'] })
    expect(decideMcpCall({ editMode: FULL, policy: p, toolName: 'exec', route: 'linear/delete' }).kind).toBe('ask')
  })

  // A call that hides its route can't inherit a route-specific allowance.
  it('asks when the route cannot be determined', () => {
    const p = trusted({ read: ['exec:linear/search'] })
    expect(decideMcpCall({ editMode: FULL, policy: p, toolName: 'exec', route: null }).kind).toBe('ask')
  })

  it('names the route in a readonly block so the reason is actionable', () => {
    const decision = decideMcpCall({ editMode: READONLY, policy: trusted(), toolName: 'exec', route: 'linear/create-issue' })
    expect(decision).toMatchObject({ kind: 'block' })
    expect((decision as { reason: string }).reason).toContain('exec (linear/create-issue)')
  })

  it('honours always-ask on a route', () => {
    const p = trusted({ read: ['exec:linear'], alwaysAsk: ['exec:linear/create-issue'] })

    expect(decideMcpCall({ editMode: FULL, policy: p, toolName: 'exec', route: 'linear/search' }).kind).toBe('allow')
    expect(decideMcpCall({ editMode: FULL, policy: p, toolName: 'exec', route: 'linear/create-issue' }).kind).toBe('ask')
  })

  it('lets a readonly session use a confirmed read route', () => {
    const p = trusted({ read: ['exec:mgs/search'] })
    expect(decideMcpCall({ editMode: READONLY, policy: p, toolName: 'exec', route: 'mgs/search' }).kind).toBe('allow')
  })
})

describe('readOnlyToolNames with routes', () => {
  it('exposes the tool when only one of its routes is a confirmed read', () => {
    expect(readOnlyToolNames(policy({ read: ['exec:mgs/search'] }))).toEqual(['exec'])
  })

  it('dedupes several routes on the same tool', () => {
    expect(readOnlyToolNames(policy({ read: ['exec:mgs/search', 'exec:linear/search'] }))).toEqual(['exec'])
  })
})
