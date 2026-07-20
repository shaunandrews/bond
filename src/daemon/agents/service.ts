/**
 * RPC-facing agent roster service — the shape the Agents tab consumes.
 */

import type { AgentRosterResult, AgentSettings, AgentSummary } from '../../shared/agents'
import { normalizeAgentSettings } from '../../shared/agents'
import { getApprovedRunnerHashes, revokeRunnerHash, setAgentSettingsOverride } from '../settings'
import { isRunnerApproved, runnerHash } from './evidence'
import { effectiveAgentSettings, findAgent, loadAgentRoster } from './registry'
import type { AgentDefinition } from './definition'

function summarize(definition: AgentDefinition, approvedHashes: string[]): AgentSummary {
  return {
    name: definition.name,
    label: definition.label,
    role: definition.role,
    mark: definition.mark,
    bio: definition.bio,
    source: definition.source,
    sourcePath: definition.sourcePath,
    verbs: definition.verbs.map(verb => ({ name: verb.name, description: verb.description })),
    evidence: definition.evidence.map(runner => ({
      name: runner.name,
      command: runner.command,
      kind: runner.kind,
      // Native runners are Bond code — always "approved"; only shell commands gate.
      approved: runner.kind === 'native' || isRunnerApproved(runner.command, approvedHashes),
    })),
    contextDocs: definition.contextDocs,
    settings: effectiveAgentSettings(definition),
    defaults: definition.defaults,
  }
}

export function listAgents(): AgentRosterResult {
  const { agents, problems } = loadAgentRoster()
  const approved = getApprovedRunnerHashes()
  return { agents: agents.map(definition => summarize(definition, approved)), problems }
}

export function updateAgentSettings(name: string, settings: Partial<AgentSettings>): AgentSummary {
  const definition = findAgent(name)
  if (!definition) throw new Error(`Unknown agent "${name}".`)
  // Merge over the agent's CURRENT effective settings so a partial update
  // can't silently reset the fields it didn't mention.
  const merged = normalizeAgentSettings({ ...effectiveAgentSettings(definition), ...settings }, definition.defaults)
  setAgentSettingsOverride(definition.name, merged)
  return summarize(definition, getApprovedRunnerHashes())
}

/** Revoke a previously approved evidence runner command. */
export function revokeAgentRunner(command: string): AgentRosterResult {
  revokeRunnerHash(runnerHash(command))
  return listAgents()
}
