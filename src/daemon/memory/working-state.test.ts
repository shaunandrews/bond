import { describe, expect, it } from 'vitest'
import { MEMORY_CAPS } from './types'
import { createWorkingState, mergeWorkingState, renderWorkingStateForPrompt } from './working-state'

describe('working state memory', () => {
  it('creates a normalized empty state', () => {
    const state = createWorkingState({ goal: '  ship   memory  ' })
    expect(state.sessionId).toBeNull()
    expect(state.goal).toBe('ship memory')
  })

  it('merges lists with deterministic tail caps', () => {
    const current = createWorkingState({
      facts: Array.from({ length: MEMORY_CAPS.workingFacts }, (_, i) => `old ${i}`),
    })
    const next = mergeWorkingState(current, { facts: ['old 1', 'new 1', 'new 2'] })
    expect(next.facts).toHaveLength(MEMORY_CAPS.workingFacts)
    expect(next.facts).not.toContain('old 0')
    expect(next.facts).toContain('new 1')
    expect(next.facts).toContain('new 2')
  })

  it('renders only populated prompt sections', () => {
    const state = createWorkingState({ goal: 'Fix it', decisions: ['Do the small thing'] })
    expect(renderWorkingStateForPrompt(state)).toBe('Goal: Fix it\n\nDecisions:\n- Do the small thing')
  })
})

describe('working artifacts', () => {
  const AUDIT_DOC = '/Users/shaun/Library/Application Support/bond/library/058eb00f-4d8c-4bb2-93c4-a4aaa16e7290.md'

  it('refreshes a same-ref artifact in place instead of duplicating it', () => {
    const current = createWorkingState({ artifacts: [{ kind: 'library', ref: AUDIT_DOC, lastTouchedAt: '2026-07-21T09:19:00.000Z' }] })
    const next = mergeWorkingState(current, { artifacts: [{ kind: 'library', ref: AUDIT_DOC, lastTouchedAt: '2026-07-21T18:00:00.000Z' }] })
    expect(next.artifacts).toHaveLength(1)
    expect(next.artifacts[0].lastTouchedAt).toBe('2026-07-21T18:00:00.000Z')
  })

  it('keeps the newest 8 and evicts the oldest', () => {
    const current = createWorkingState({
      artifacts: Array.from({ length: MEMORY_CAPS.workingArtifacts }, (_, i) => ({
        kind: 'file' as const,
        ref: `/tmp/file-${i}.ts`,
        lastTouchedAt: `2026-07-21T1${i}:00:00.000Z`,
      })),
    })
    const next = mergeWorkingState(current, { artifacts: [{ kind: 'issue', ref: 'STU-2085', lastTouchedAt: '2026-07-21T19:00:00.000Z' }] })
    expect(next.artifacts).toHaveLength(MEMORY_CAPS.workingArtifacts)
    expect(next.artifacts[0].ref).toBe('STU-2085')
    expect(next.artifacts.map(a => a.ref)).not.toContain('/tmp/file-0.ts')
  })

  it('patch-if-provided semantics for activeSkill and checkpoint', () => {
    const current = createWorkingState({ activeSkill: 'audit-triage-feedback', checkpoint: 'item 7 of 18' })
    expect(mergeWorkingState(current, { checkpoint: 'item 8 of 18' })).toMatchObject({
      activeSkill: 'audit-triage-feedback',
      checkpoint: 'item 8 of 18',
    })
    expect(mergeWorkingState(current, { checkpoint: null }).checkpoint).toBeNull()
    expect(mergeWorkingState(current, {}).activeSkill).toBe('audit-triage-feedback')
  })

  it('loads working memory persisted before artifacts existed', () => {
    const legacy = JSON.parse('{"sessionId":null,"projectId":null,"goal":"g","facts":["f"],"preferences":[],"decisions":[],"openThreads":[],"updatedAt":"2026-07-21T17:10:21.000Z"}')
    const state = createWorkingState(legacy)
    expect(state).toMatchObject({ goal: 'g', facts: ['f'], artifacts: [], activeSkill: null, checkpoint: null })
  })

  it('THE INCIDENT: renders the artifact and the skill Bond could not recall', () => {
    // 2026-07-21, 2:26pm: "Lets move on to 9." Bond searched, found nothing, and
    // asked what item 9 was. Both the document and the skill existed; neither
    // appeared anywhere in the 10,893-char context envelope. This assertion is
    // the one that fails against the pre-fix code.
    const state = createWorkingState({
      goal: 'Continue the Studio trunk audit and file findings as Linear issues.',
      artifacts: [
        { kind: 'library', ref: AUDIT_DOC, label: 'Studio trunk audit — July 21, 2026', lastTouchedAt: '2026-07-21T18:00:00.000Z' },
        { kind: 'issue', ref: 'STU-2085', lastTouchedAt: '2026-07-21T17:50:00.000Z' },
      ],
      activeSkill: 'audit-triage-feedback',
      checkpoint: 'audit item 8 of 18 filed; next 9',
      facts: ['Mobile composer notes from an earlier task'],
    })

    const rendered = renderWorkingStateForPrompt(state)
    expect(rendered).toContain('058eb00f')
    expect(rendered).toContain('audit-triage-feedback')
    expect(rendered).toContain('audit item 8 of 18 filed; next 9')
    expect(rendered).toContain('STU-2085')
    // Artifacts lead; the stale fact tail does not.
    expect(rendered.indexOf('Working on:')).toBeLessThan(rendered.indexOf('Facts:'))
  })
})
