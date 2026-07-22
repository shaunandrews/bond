import type { AgentRunQReviewer } from './publisher'
import { resolveContextDocs } from '../context-docs'
import { effectiveAgentSettings, findAgent } from '../registry'
import { runAgentConsult } from '../run-agent'

/**
 * Q receives only read paths plus the associated PR identity. It has no GitHub
 * transport, command runner, write tool, token, or generic comment capability.
 */
export const qAgentRunReviewer: AgentRunQReviewer = {
  async review({ run, publication, changedPaths }) {
    if (run.workspace.isolation !== 'worktree') throw new Error('Q review requires the retained run worktree.')
    const workspace = run.workspace
    const definition = findAgent('q')
    if (!definition) throw new Error('Q is not available.')
    const verb = definition.verbs.find(entry => entry.name === 'review')
    if (!verb) throw new Error('Q has no review verb.')
    const paths = changedPaths.map(path => `${workspace.worktreePath}/${path}`)
    const docs = resolveContextDocs(paths, definition.contextDocs)
    return runAgentConsult({
      definition,
      verb,
      settings: effectiveAgentSettings(definition),
      brief: [
        `Review the committed Mathis change for draft PR #${publication.prNumber}.`,
        `Associated run: ${run.id}. Base: ${run.baseSha}.`,
        'This is advisory. Report concrete defects and missing tests; never propose or perform GitHub operations.',
      ].join('\n'),
      paths,
      docs,
      evidence: [],
      cwd: workspace.worktreePath,
      allowedRoot: workspace.worktreePath,
    })
  },
}
