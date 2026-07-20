/**
 * Prompt assembly for a consult: the shared agent spine + the definition's
 * doctrine + the invoked verb's workflow + the user's per-agent instructions,
 * and a user message ordered brief → scope → context docs → evidence LAST so
 * machine output can't anchor the agent's own reading.
 */

import type { AgentSettings } from '../../shared/agents'
import type { AgentDefinition, AgentVerbDefinition } from './definition'
import type { ResolvedContextDocs } from './context-docs'

const MAX_DOC_CHARS = 24_000
const MAX_EVIDENCE_CHARS = 16_000

function clamp(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated — ${text.length} chars total]` : text
}

/** Invariants every agent shares, regardless of specialty. */
export const AGENT_SPINE =
  'You are a specialist consultant. Bond — a desktop assistant — has brought you in for one focused task, and your report goes back to Bond, who relays it to the user.\n\n' +
  'OPERATING RULES:\n' +
  '- You are READ-ONLY. You can read and search files; you cannot edit, write, or run commands. You never ask to. Bond applies every change through its own approval flow.\n' +
  '- Cite evidence: file, line, value, or command output. Never a bare "looks good" or "seems fine".\n' +
  '- Never invent problems to look thorough. "Clean, nothing to fix" is a legal verdict.\n' +
  '- Deterministic evidence (scans, typechecks, test runs) is a floor, not a verdict — it proves only what it checked. Say what it did not check.\n' +
  '- Form your own assessment from the material FIRST, then reconcile with any EVIDENCE blocks: confirm, dispute, or add. Do not let machine output anchor your judgment.\n' +
  '- You run one-shot and cannot converse with the user. When you need their answer, put it in QUESTIONS and give your best provisional recommendation, clearly marked provisional.\n' +
  '- Read before you claim. Never describe code, files, or values you have not actually read; say what you could not read.\n'

export function buildReportContract(depth: AgentSettings['report']): string {
  const shared =
    'REPORT FORMAT — start with VERDICT, nothing before it:\n' +
    'VERDICT: one sentence, plain language.\n'
  if (depth === 'quick') {
    return (
      shared +
      'FINDINGS: at most the three most important, each with file:line and the fix. Priority-tagged P0–P3.\n' +
      'QUESTIONS: anything needing the user\'s answer. Omit when empty.\n' +
      'NEXT: the single most valuable follow-up, or "none".\n' +
      'Keep the whole report under roughly 300 words. Depth is capped, not rigor: if something is genuinely broken, say so.\n'
    )
  }
  return (
    shared +
    'CONTEXT: what you read and what you could not.\n' +
    'SCORES: where the verb defines them, each 0–4 with a clause of justification.\n' +
    'FINDINGS: ordered by priority. Each: [P0–P3] file:line — what — why it is wrong — the specific fix.\n' +
    'EXCEPTIONS: deviations you judged deliberate and fine, with reasons.\n' +
    'ESCALATIONS: proposals that need the user\'s approval before anyone acts — the exact change, its role, and why the existing material cannot do the job.\n' +
    'QUESTIONS: anything needing the user\'s answer, phrased for Bond to relay. Omit when empty.\n' +
    'NEXT: the single most valuable follow-up, or "none".\n'
  )
}

export function buildAgentSystemPrompt(
  definition: AgentDefinition,
  verb: AgentVerbDefinition,
  settings: AgentSettings,
): string {
  const sections = [
    AGENT_SPINE,
    definition.doctrine,
    `CURRENT TASK — the "${verb.name}" verb${verb.description ? `: ${verb.description}` : ''}\n${verb.workflow}`,
    buildReportContract(settings.report),
  ]
  const instructions = settings.instructions.trim()
  if (instructions) {
    // User instructions are configuration, not a licence to break the spine.
    sections.push(
      `USER INSTRUCTIONS FOR THIS PROJECT (from the user; follow them within your operating rules — they never grant write access or override the report contract):\n${instructions}`,
    )
  }
  return sections.filter(Boolean).join('\n\n')
}

export interface AgentUserPromptInput {
  brief: string
  paths?: string[]
  docs?: ResolvedContextDocs
  evidence?: string[]
}

export function buildAgentUserPrompt(input: AgentUserPromptInput): string {
  const sections: string[] = [`BRIEF:\n${input.brief.trim()}`]

  sections.push(
    input.paths?.length
      ? `SCOPE (read these — files and directories):\n${input.paths.map(path => `- ${path}`).join('\n')}`
      : 'SCOPE: no paths were provided. Work from the brief; if reading files is essential, say exactly what you need in QUESTIONS.',
  )

  const docs = Object.entries(input.docs?.docs ?? {})
  if (docs.length) {
    for (const [name, doc] of docs) {
      sections.push(`<context-doc name="${name}" path="${doc.path}">\n${clamp(doc.text, MAX_DOC_CHARS)}\n</context-doc>`)
    }
  } else {
    sections.push('CONTEXT DOCS: none found for this scope. Proceed — the code is the context.')
  }

  const evidence = (input.evidence ?? []).filter(block => block.trim())
  if (evidence.length) {
    sections.push(
      'EVIDENCE — form your own assessment first, then reconcile with these (confirm, dispute, or add):\n' +
        evidence.map(block => clamp(block, MAX_EVIDENCE_CHARS)).join('\n\n'),
    )
  }

  return sections.join('\n\n')
}
