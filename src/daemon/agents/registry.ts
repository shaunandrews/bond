/**
 * The agent roster — bundled definitions plus ~/.bond/agents/<name>/AGENT.md,
 * with a disk definition overriding a bundled one of the same name.
 *
 * Definitions that fail validation are never silently dropped: they come back
 * as `problems` so the Agents tab can show the reason and the author can fix
 * it. Scanned per call (like skills) — a daemon restart is never required to
 * pick up an edit, though the roster prompt section is built per turn.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentProblem, AgentSettings } from '../../shared/agents'
import { normalizeAgentSettings } from '../../shared/agents'
import { getAgentSettingsOverride } from '../settings'
import { BUILTIN_AGENT_SOURCES } from './builtin'
import { parseAgentDefinition, type AgentDefinition } from './definition'

export interface AgentRoster {
  agents: AgentDefinition[]
  problems: AgentProblem[]
}

export function getAgentsDir(): string {
  return join(homedir(), '.bond', 'agents')
}

function scanDiskAgents(dir: string): AgentRoster {
  if (!existsSync(dir)) return { agents: [], problems: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { agents: [], problems: [] }
  }

  const agents: AgentDefinition[] = []
  const problems: AgentProblem[] = []
  for (const entry of entries) {
    const file = join(dir, entry, 'AGENT.md')
    if (!existsSync(file)) continue
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch (error) {
      problems.push({ source: file, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const parsed = parseAgentDefinition(content, { source: 'user', sourcePath: file })
    if (parsed.ok) agents.push(parsed.definition)
    else problems.push({ source: file, reason: parsed.errors.join('; ') })
  }
  return { agents, problems }
}

/** Bundled + disk definitions; a user file wins over a bundled agent of the same name. */
export function loadAgentRoster(options: { dir?: string } = {}): AgentRoster {
  const problems: AgentProblem[] = []
  const byName = new Map<string, AgentDefinition>()

  for (const source of BUILTIN_AGENT_SOURCES) {
    const parsed = parseAgentDefinition(source, { source: 'builtin' })
    if (parsed.ok) byName.set(parsed.definition.name, parsed.definition)
    // A malformed bundled definition is a Bond bug, not a user problem — make it loud.
    else problems.push({ source: 'builtin', reason: `bundled agent failed to parse: ${parsed.errors.join('; ')}` })
  }

  const disk = scanDiskAgents(options.dir ?? getAgentsDir())
  problems.push(...disk.problems)
  for (const definition of disk.agents) byName.set(definition.name, definition)

  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems }
}

export function findAgent(name: string, options: { dir?: string } = {}): AgentDefinition | undefined {
  return loadAgentRoster(options).agents.find(agent => agent.name === name.toLowerCase())
}

/** Definition defaults with the persisted settings layer applied. */
export function effectiveAgentSettings(definition: AgentDefinition): AgentSettings {
  return normalizeAgentSettings(getAgentSettingsOverride(definition.name), definition.defaults)
}
