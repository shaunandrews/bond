/**
 * The consult_designer Pi tool — Bond's doorway to Felix.
 *
 * The tool does the deterministic prep (context-doc resolution, the pinned
 * Impeccable detector, the migration inventory) and hands everything to an
 * isolated Felix session as labeled evidence. Felix stays read-only, so this
 * tool is available in every edit mode and never triggers approvals.
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { FELIX_VERBS, type FelixRegister, type FelixVerb } from './doctrine'
import { resolveContextDocs } from './context-docs'
import { formatDetectorEvidence, runImpeccableDetect } from './detector'
import { runMigrationInventory } from './migrate'
import { runFelixQuery } from './felix'

export const DESIGN_TOOL_NAMES = ['consult_designer']

export interface DesignToolOptions {
  /** Capability tier of the parent turn, inherited by Felix's session. */
  model?: string
  /** Injection points for tests. */
  runFelix?: typeof runFelixQuery
  detect?: typeof runImpeccableDetect
  inventory?: typeof runMigrationInventory
  resolveDocs?: typeof resolveContextDocs
}

export function expandPath(path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
  return resolve(homedir(), expanded)
}

function parseVerb(value: string): FelixVerb {
  if ((FELIX_VERBS as string[]).includes(value)) return value as FelixVerb
  throw new Error(`Unknown verb "${value}". Use one of: ${FELIX_VERBS.join(', ')}.`)
}

function parseRegister(value: string | undefined): FelixRegister | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'brand' || value === 'product') return value
  throw new Error(`Unknown register "${value}". Use "brand", "product", or omit it and Felix will infer.`)
}

export function registerDesignTools(pi: ExtensionAPI, options: DesignToolOptions = {}): void {
  const runFelix = options.runFelix ?? runFelixQuery
  const detect = options.detect ?? runImpeccableDetect
  const inventory = options.inventory ?? runMigrationInventory
  const resolveDocs = options.resolveDocs ?? resolveContextDocs

  pi.registerTool({
    name: 'consult_designer',
    label: 'Consult Felix',
    description:
      'Consult Felix, Bond\'s designer, for design work. Verbs: "critique" (judge a UI surface against its design system and register), ' +
      '"define" (author a DESIGN.md for a project), "refine" (grow/reconcile an existing system — extraction candidates, spec drift, token lifecycle), ' +
      '"migrate" (map off-system literal values onto tokens as a staged campaign). ' +
      'Give a specific brief and the file/directory paths in scope. Felix reads code (read-only), gets deterministic design-check evidence, ' +
      'and returns a cited report. Relay his QUESTIONS and ESCALATIONS to the user before acting on them.',
    parameters: Type.Object({
      verb: Type.String({ description: 'One of: critique, define, refine, migrate' }),
      brief: Type.String({ description: 'What you want Felix\'s take on — specific, with the user\'s goal' }),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Files/directories in scope (absolute or ~-relative)' })),
      register: Type.Optional(Type.String({ description: 'Optional: "brand" (marketing surfaces) or "product" (app UI); omit to let Felix infer' })),
    }),
    async execute(_toolCallId, params, signal) {
      const verb = parseVerb(params.verb)
      const register = parseRegister(params.register)
      const paths = (params.paths ?? []).map(expandPath)
      const docs = paths.length ? resolveDocs(paths) : {}

      const evidence: string[] = []
      // define reads what exists; judgment verbs also get the deterministic scan.
      if (verb !== 'define' && paths.length) {
        evidence.push(formatDetectorEvidence(await detect(paths, { cwd: docs.root })))
      }
      if (verb === 'migrate' && paths.length) {
        evidence.push(inventory(paths, { designMdText: docs.design?.text }).evidence)
      }

      const report = await runFelix({
        verb,
        register,
        brief: params.brief,
        paths,
        docs,
        evidence,
        model: options.model,
        signal,
      })
      return {
        content: [{ type: 'text' as const, text: report }],
        details: {
          verb,
          register: register ?? 'inferred',
          paths,
          contextDocs: { product: docs.product?.path ?? null, design: docs.design?.path ?? null },
        },
      }
    },
  })
}

export function createDesignExtensionFactory(options: DesignToolOptions = {}) {
  return (pi: ExtensionAPI) => registerDesignTools(pi, options)
}
