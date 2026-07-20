/**
 * Assembles Felix's system prompt (doctrine per verb/register) and the user
 * prompt for one consultation (brief + scope + context docs + machine
 * evidence, in that order — evidence last so it can't anchor his own pass).
 */

import {
  DESIGN_MD_SPEC,
  DOCTRINE_ATTRIBUTION,
  DOCTRINE_CORE,
  FELIX_IDENTITY,
  FELIX_REPORT_FORMAT,
  REGISTER_BRAND,
  REGISTER_PRODUCT,
  VERB_DOCTRINE,
  type FelixRegister,
  type FelixVerb,
} from './doctrine'
import type { ResolvedContextDocs } from './context-docs'

/** Context docs and evidence are capped so one giant file can't flood the prompt. */
const MAX_DOC_CHARS = 24_000
const MAX_EVIDENCE_CHARS = 16_000

function clamp(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated — ${text.length} chars total]` : text
}

export function buildFelixSystemPrompt(verb: FelixVerb, register?: FelixRegister): string {
  const registerSection = register === 'brand'
    ? REGISTER_BRAND
    : register === 'product'
      ? REGISTER_PRODUCT
      : `${REGISTER_BRAND}\n${REGISTER_PRODUCT}\nThe register was not specified — infer it from PRODUCT.md or the surface itself, and state the inference in your report.\n`
  // Critique reads systems; the authoring verbs write them and need the full contract.
  const spec = verb === 'critique' ? '' : DESIGN_MD_SPEC
  return [FELIX_IDENTITY, DOCTRINE_CORE, registerSection, VERB_DOCTRINE[verb], spec, FELIX_REPORT_FORMAT, DOCTRINE_ATTRIBUTION]
    .filter(Boolean)
    .join('\n')
}

export interface FelixUserPromptInput {
  brief: string
  paths?: string[]
  docs?: ResolvedContextDocs
  /** Pre-formatted machine evidence blocks (detector output, migration inventory). */
  evidence?: string[]
}

export function buildFelixUserPrompt(input: FelixUserPromptInput): string {
  const sections: string[] = [`BRIEF:\n${input.brief.trim()}`]

  sections.push(
    input.paths?.length
      ? `SCOPE (read these — files and directories):\n${input.paths.map(p => `- ${p}`).join('\n')}`
      : 'SCOPE: no paths were provided. Work from the brief; if code inspection is essential, say exactly what you need in QUESTIONS.',
  )

  if (input.docs?.product) {
    sections.push(`<product-md path="${input.docs.product.path}">\n${clamp(input.docs.product.text, MAX_DOC_CHARS)}\n</product-md>`)
  }
  if (input.docs?.design) {
    sections.push(`<design-md path="${input.docs.design.path}">\n${clamp(input.docs.design.text, MAX_DOC_CHARS)}\n</design-md>`)
  }
  if (!input.docs?.product && !input.docs?.design) {
    sections.push('CONTEXT DOCS: no PRODUCT.md or DESIGN.md found for this scope. Proceed — the code is the context.')
  }

  const evidence = (input.evidence ?? []).filter(block => block.trim())
  if (evidence.length) {
    sections.push(
      'MACHINE EVIDENCE — form your own assessment from the code first, then reconcile with these (confirm, dispute, or add):\n' +
      evidence.map(block => clamp(block, MAX_EVIDENCE_CHARS)).join('\n\n'),
    )
  }

  return sections.join('\n\n')
}
