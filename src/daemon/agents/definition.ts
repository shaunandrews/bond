/**
 * AGENT.md parsing — the roster's definition format.
 *
 * Frontmatter carries config (extending the skills parser with inline lists
 * and one-level maps); the body carries doctrine followed by one
 * `## verb: <name>` section per declared verb. Bundled agents go through this
 * exact parser, so a built-in and a user-authored agent can never diverge.
 */

import {
  clampLeash,
  DEFAULT_AGENT_SETTINGS,
  GRANTABLE_AGENT_TOOLS,
  AGENT_MODEL_SETTINGS,
  AGENT_POLICIES,
  AGENT_REPORT_DEPTHS,
  AGENT_THINKING_LEVELS,
  AGENT_WORKSPACE_SETTINGS,
  AGENT_BUDGET_PRESETS,
  type AgentSettings,
} from '../../shared/agents'

export interface AgentEvidenceRunner {
  name: string
  /** `builtin:<id>` for native Bond runners, otherwise a shell command. */
  command: string
  kind: 'native' | 'shell'
  /** Verbs this runner applies to; empty means every verb. */
  verbs: string[]
}

export interface AgentVerbDefinition {
  name: string
  description: string
  workflow: string
}

export interface AgentDefinition {
  name: string
  label: string
  role: string
  mark: string
  bio: string
  source: 'builtin' | 'user'
  sourcePath: string | null
  doctrine: string
  verbs: AgentVerbDefinition[]
  evidence: AgentEvidenceRunner[]
  contextDocs: string[]
  defaults: AgentSettings
}

export type ParseAgentResult =
  | { ok: true; definition: AgentDefinition }
  | { ok: false; errors: string[] }

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const NATIVE_PREFIX = 'builtin:'

type FrontmatterValue = string | string[] | Record<string, string>

function stripQuotes(value: string): string {
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value
}

/**
 * Frontmatter subset: `key: value`, `key: [a, b]`, and one level of
 * `key:` + indented `sub: value`. Deliberately not a YAML engine — the format
 * is a flat config header, and a real parser is a dependency we don't need.
 */
export function parseAgentFrontmatter(content: string): Record<string, FrontmatterValue> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, FrontmatterValue> = {}
  let currentMap: { key: string; entries: Record<string, string> } | null = null

  const flush = () => {
    if (currentMap) result[currentMap.key] = currentMap.entries
    currentMap = null
  }

  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indented = /^\s/.test(line)
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = stripQuotes(line.slice(separator + 1).trim())

    if (indented && currentMap) {
      currentMap.entries[key] = value
      continue
    }
    flush()
    if (!value) {
      currentMap = { key, entries: {} }
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map(item => stripQuotes(item.trim()))
        .filter(Boolean)
      continue
    }
    result[key] = value
  }
  flush()
  return result
}

function asString(value: FrontmatterValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function asList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return value.split(',').map(item => item.trim()).filter(Boolean)
  return []
}

function asMap(value: FrontmatterValue | undefined): Record<string, string> {
  return value && !Array.isArray(value) && typeof value === 'object' ? value : {}
}

/** Splits the body into doctrine + verb sections keyed by `## verb: name — description`. */
export function splitVerbSections(body: string): { doctrine: string; sections: Map<string, { description: string; workflow: string }> } {
  const lines = body.split('\n')
  const sections = new Map<string, { description: string; workflow: string }>()
  const doctrineLines: string[] = []
  let current: { name: string; description: string; lines: string[] } | null = null

  const commit = () => {
    if (current) sections.set(current.name, { description: current.description, workflow: current.lines.join('\n').trim() })
    current = null
  }

  for (const line of lines) {
    const header = line.match(/^##\s+verb:\s*([a-z][a-z0-9-]*)\s*(?:[—–-]\s*(.*))?$/i)
    if (header) {
      commit()
      current = { name: header[1].toLowerCase(), description: (header[2] ?? '').trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else doctrineLines.push(line)
  }
  commit()
  return { doctrine: doctrineLines.join('\n').trim(), sections }
}

function settingsFromFrontmatter(frontmatter: Record<string, FrontmatterValue>, errors: string[]): AgentSettings {
  const pick = <T extends string>(key: string, allowed: T[], fallback: T): T => {
    const raw = asString(frontmatter[key])
    if (!raw) return fallback
    if (!allowed.includes(raw as T)) {
      errors.push(`${key}: "${raw}" is not one of ${allowed.join(', ')}`)
      return fallback
    }
    return raw as T
  }

  const tools = asList(frontmatter.tools)
  const invalidTools = tools.filter(tool => !(GRANTABLE_AGENT_TOOLS as readonly string[]).includes(tool))
  if (invalidTools.length) {
    errors.push(`tools: ${invalidTools.join(', ')} — grantable tools are ${GRANTABLE_AGENT_TOOLS.join(', ')} (agents are read-only)`)
  }

  const leashRaw = asString(frontmatter.leash)
  const leash = leashRaw ? Number(leashRaw) : DEFAULT_AGENT_SETTINGS.leash
  if (leashRaw && !Number.isFinite(leash)) errors.push(`leash: "${leashRaw}" is not a number`)

  return {
    model: pick('model', AGENT_MODEL_SETTINGS, DEFAULT_AGENT_SETTINGS.model),
    thinking: pick('thinking', AGENT_THINKING_LEVELS, DEFAULT_AGENT_SETTINGS.thinking),
    report: pick('report', AGENT_REPORT_DEPTHS, DEFAULT_AGENT_SETTINGS.report),
    policy: pick('policy', AGENT_POLICIES, DEFAULT_AGENT_SETTINGS.policy),
    workspace: pick('workspace', AGENT_WORKSPACE_SETTINGS, DEFAULT_AGENT_SETTINGS.workspace),
    budgetPreset: pick('budgetPreset', AGENT_BUDGET_PRESETS, DEFAULT_AGENT_SETTINGS.budgetPreset),
    leash: clampLeash(leash),
    instructions: '',
    tools: tools.filter(tool => (GRANTABLE_AGENT_TOOLS as readonly string[]).includes(tool)),
  }
}

export function parseAgentDefinition(
  content: string,
  context: { source: 'builtin' | 'user'; sourcePath?: string | null },
): ParseAgentResult {
  const errors: string[] = []
  const hasFrontmatter = /^---\s*\n[\s\S]*?\n---/.test(content)
  if (!hasFrontmatter) errors.push('frontmatter is required — a --- delimited block at the top of the file')
  const frontmatter = parseAgentFrontmatter(content)
  const body = hasFrontmatter ? content.replace(/^---\s*\n[\s\S]*?\n---\n?/, '') : content

  const name = asString(frontmatter.name).toLowerCase()
  if (!name) errors.push('name is required')
  else if (!NAME_RE.test(name)) errors.push(`name: "${name}" must be lowercase letters, digits, or dashes`)

  const declaredVerbs = asList(frontmatter.verbs).map(verb => verb.toLowerCase())
  if (!declaredVerbs.length) errors.push('verbs: at least one verb is required')

  const { doctrine, sections } = splitVerbSections(body)
  if (!doctrine.trim()) errors.push('body: doctrine is required before the first "## verb:" section')

  const verbs: AgentVerbDefinition[] = []
  for (const verb of declaredVerbs) {
    const section = sections.get(verb)
    if (!section) {
      errors.push(`verbs: "${verb}" is declared but has no "## verb: ${verb}" section`)
      continue
    }
    verbs.push({ name: verb, description: section.description, workflow: section.workflow })
  }
  for (const declared of sections.keys()) {
    if (!declaredVerbs.includes(declared)) errors.push(`body: "## verb: ${declared}" is not listed in the verbs frontmatter`)
  }

  const evidence: AgentEvidenceRunner[] = Object.entries(asMap(frontmatter.evidence)).map(([runnerName, raw]) => {
    // Optional trailing verb scope: `tests: npm run test:run [review, patch]`
    const scoped = raw.match(/^(.*?)\s*\[([^\]]*)\]\s*$/)
    const command = (scoped ? scoped[1] : raw).trim()
    const verbs = scoped ? scoped[2].split(',').map(verb => verb.trim().toLowerCase()).filter(Boolean) : []
    for (const verb of verbs) {
      if (!declaredVerbs.includes(verb)) errors.push(`evidence.${runnerName}: scoped to "${verb}", which is not a declared verb`)
    }
    if (!command) errors.push(`evidence.${runnerName}: command is empty`)
    return {
      name: runnerName,
      command,
      kind: command.startsWith(NATIVE_PREFIX) ? ('native' as const) : ('shell' as const),
      verbs,
    }
  })
  // Native runners are Bond code referenced by name; a user file naming one
  // would grant itself Bond internals it wasn't audited for.
  if (context.source === 'user') {
    for (const runner of evidence.filter(entry => entry.kind === 'native')) {
      errors.push(`evidence.${runner.name}: builtin: runners are reserved for bundled agents`)
    }
  }

  const defaults = settingsFromFrontmatter(frontmatter, errors)
  if (errors.length) return { ok: false, errors }

  return {
    ok: true,
    definition: {
      name,
      label: asString(frontmatter.label) || name.charAt(0).toUpperCase() + name.slice(1),
      role: asString(frontmatter.role),
      mark: asString(frontmatter.mark) || name.charAt(0).toUpperCase(),
      bio: asString(frontmatter.bio),
      source: context.source,
      sourcePath: context.sourcePath ?? null,
      doctrine,
      verbs,
      evidence,
      contextDocs: asList(frontmatter['context-docs']),
      defaults,
    },
  }
}
