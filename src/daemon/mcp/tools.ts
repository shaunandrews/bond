/**
 * Bond's MCP tool surface: the `mcp` proxy tool, plus any tools the user has
 * promoted to first-class Pi tools.
 *
 * The proxy keeps the prompt small — the model discovers what exists with
 * `search`, reads a schema with `describe`, and runs one with `call`.
 * Promotion is the escape hatch for tools used often enough to deserve their
 * own schema in the prompt.
 *
 * Both paths run every call through the SAME gate (`decideMcpCall` in
 * policy.ts), so there is exactly one answer to "may this run, and must a
 * human say so first".
 */

import { randomUUID } from 'node:crypto'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { EditMode } from '../../shared/session'
import type { BondStreamChunk } from '../../shared/stream'
import { registerApproval, type ApprovalResult } from '../approvals'
import { flattenCallResult, MAX_RESULT_CHARS } from './content'
import {
  callTool as managerCallTool,
  describeTool as managerDescribeTool,
  policyFor as managerPolicyFor,
  searchCatalog as managerSearchCatalog,
  McpServerError,
  type McpToolInfo,
} from './manager'
import { decideMcpCall, type McpDecision, type PromotionTarget } from './policy'

export const MCP_TOOL_NAMES = ['mcp']

const MAX_SEARCH_RESULTS = 25

export interface McpToolDeps {
  searchCatalog: typeof managerSearchCatalog
  describeTool: typeof managerDescribeTool
  callTool: typeof managerCallTool
  policyFor: typeof managerPolicyFor
}

export interface PromotedTool extends PromotionTarget {
  info: McpToolInfo
}

export interface McpToolOptions {
  /** Turn id owning any approval this tool parks. */
  turnId: string
  onChunk: (chunk: BondStreamChunk) => void
  abortSignal?: AbortSignal
  /** Governs the policy gate; defaults to full access. */
  editMode?: EditMode
  /** Tools the user pinned, with schemas prefetched by the caller. */
  promoted?: PromotedTool[]
  /** Test seam — defaults to the daemon-lifetime manager singleton. */
  deps?: Partial<McpToolDeps>
  /** Test seam — defaults to the shared approvals registry. */
  requestApproval?: (input: McpApprovalInput) => Promise<ApprovalResult>
  maxResultChars?: number
}

export interface McpApprovalInput {
  requestId: string
  server: string
  tool: string
  arguments: Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

/** Compact per-tool shape for `search` — full schemas belong to `describe`. */
function summarize(tool: McpToolInfo) {
  return {
    server: tool.server,
    tool: tool.name,
    description: tool.description.slice(0, 300),
  }
}

/** The prompt line a human sees: "Allow context-a8c: search_p2?" */
export function approvalTitle(server: string, tool: string): string {
  return `Allow ${server}: ${tool}?`
}

/** One-line preview of the call arguments for the approval prompt. */
export function approvalDescription(args: Record<string, unknown>): string | undefined {
  const keys = Object.keys(args)
  if (!keys.length) return undefined
  try {
    return JSON.stringify(args).slice(0, 300)
  } catch {
    return keys.join(', ')
  }
}

/** The Pi parameter schema for a promoted tool, falling back to a free-form object. */
export function promotedParameters(inputSchema: unknown) {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema as Record<string, unknown> : null
  if (schema && schema.type === 'object') return schema as never
  return Type.Object({}, { additionalProperties: true }) as never
}

export function registerMcpTools(pi: ExtensionAPI, options: McpToolOptions): void {
  const deps: McpToolDeps = {
    searchCatalog: options.deps?.searchCatalog ?? managerSearchCatalog,
    describeTool: options.deps?.describeTool ?? managerDescribeTool,
    callTool: options.deps?.callTool ?? managerCallTool,
    policyFor: options.deps?.policyFor ?? managerPolicyFor,
  }
  const maxResultChars = options.maxResultChars ?? MAX_RESULT_CHARS
  const editMode: EditMode = options.editMode ?? { type: 'full' }

  const askForApproval = options.requestApproval ?? ((input: McpApprovalInput) => {
    options.onChunk({
      kind: 'tool_approval',
      requestId: input.requestId,
      toolName: 'mcp',
      input: { server: input.server, tool: input.tool, arguments: input.arguments },
      title: approvalTitle(input.server, input.tool),
      description: approvalDescription(input.arguments),
    })
    return registerApproval(input.requestId, options.turnId)
  })

  /** Gate → (maybe) prompt → run. The only path to an MCP server from a turn. */
  async function runMcpCall(server: string, tool: string, args: Record<string, unknown>, abortSignal?: AbortSignal) {
    const decision: McpDecision = decideMcpCall({ editMode, policy: deps.policyFor(server), toolName: tool })
    if (decision.kind === 'block') {
      return toolResult({ server, tool, approved: false, error: decision.reason })
    }

    let finalArgs = args
    if (decision.kind === 'ask') {
      const requestId = randomUUID()
      const answer = await askForApproval({ requestId, server, tool, arguments: args })
      if (!answer.approved) {
        return toolResult({ server, tool, approved: false, error: 'The user denied this MCP call. Do not retry it — ask what they would prefer.' })
      }
      // An approver can edit the arguments before allowing the call.
      finalArgs = (answer.input?.arguments as Record<string, unknown> | undefined) ?? args
    }

    try {
      const result = await deps.callTool(server, tool, finalArgs, abortSignal)
      const flattened = flattenCallResult(result, maxResultChars)
      return toolResult({
        server,
        tool,
        approved: true,
        autoApproved: decision.kind === 'allow',
        isError: flattened.isError,
        truncated: flattened.truncated,
        result: flattened.text,
        ...(flattened.structuredContent !== undefined ? { structuredContent: flattened.structuredContent } : {}),
      })
    } catch (error) {
      // A down or misbehaving server is feedback for the model, never a
      // thrown error — an MCP failure must not take the turn down with it.
      return toolResult({
        server,
        tool,
        approved: true,
        error: error instanceof McpServerError
          ? `MCP server "${server}" could not run ${tool}: ${error.message}`
          : errorMessage(error),
      })
    }
  }

  pi.registerTool({
    name: 'mcp',
    label: 'MCP',
    description: [
      'Use tools from connected MCP servers (Model Context Protocol integrations the user has configured).',
      'Workflow: search to find a tool, describe to read its exact input schema, then call it.',
      'Never guess at arguments — describe first. Calls the user has not pre-approved will ask them first.',
      'If no servers are configured, search returns an empty catalog; say so rather than retrying.',
    ].join(' '),
    parameters: Type.Object({
      action: Type.Union([Type.Literal('search'), Type.Literal('describe'), Type.Literal('call')], {
        description: 'search: find tools; describe: read one tool\'s input schema; call: run a tool',
      }),
      query: Type.Optional(Type.String({ description: 'search only — words to match against tool names and descriptions. Omit to list everything.' })),
      server: Type.Optional(Type.String({ description: 'Server id. Required for describe and call; optional filter for search.' })),
      tool: Type.Optional(Type.String({ description: 'Tool name. Required for describe and call.' })),
      arguments: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'call only — arguments matching the tool\'s input schema.' })),
    }),
    // Pi hands each call its own AbortSignal; prefer it over the turn-wide one
    // so cancelling a single tool call doesn't need the whole turn to end.
    async execute(_toolCallId, params, signal) {
      const abortSignal = signal ?? options.abortSignal
      const action = params.action
      const server = typeof params.server === 'string' ? params.server.trim() : ''
      const tool = typeof params.tool === 'string' ? params.tool.trim() : ''

      if (action === 'search') {
        const { tools, errors } = await deps.searchCatalog(params.query, server || undefined)
        return toolResult({
          action,
          tools: tools.slice(0, MAX_SEARCH_RESULTS).map(summarize),
          totalMatches: tools.length,
          ...(errors.length ? { unavailableServers: errors } : {}),
          ...(tools.length === 0 && errors.length === 0
            ? { note: 'No MCP tools matched. The user may not have any MCP servers connected.' }
            : {}),
        })
      }

      if (!server || !tool) {
        return toolResult({ action, error: `${action} needs both "server" and "tool". Run action: "search" first to find them.` })
      }

      if (action === 'describe') {
        try {
          const info = await deps.describeTool(server, tool)
          return toolResult({ action, server: info.server, tool: info.name, description: info.description, inputSchema: info.inputSchema })
        } catch (error) {
          return toolResult({ action, server, tool, error: errorMessage(error) })
        }
      }

      const result = await runMcpCall(server, tool, (params.arguments ?? {}) as Record<string, unknown>, abortSignal)
      return toolResult({ action, ...(result.details as Record<string, unknown>) })
    },
  })

  // --- Promoted tools ---
  for (const promoted of options.promoted ?? []) {
    pi.registerTool({
      name: promoted.piName,
      label: `${promoted.server}: ${promoted.tool}`,
      description: promoted.info.description || `The "${promoted.tool}" tool from the ${promoted.info.serverName} MCP server.`,
      parameters: promotedParameters(promoted.info.inputSchema),
      async execute(_toolCallId, params, signal) {
        return await runMcpCall(
          promoted.server,
          promoted.tool,
          (params ?? {}) as Record<string, unknown>,
          signal ?? options.abortSignal,
        )
      },
    })
  }
}

export function createMcpExtensionFactory(options: McpToolOptions) {
  return (pi: ExtensionAPI) => registerMcpTools(pi, options)
}
