import { beforeEach, describe, expect, it } from 'vitest'
import { resetReadCountsForTest, workingPatchFromToolEvent } from './artifacts'

const deps = {
  libraryDir: '/Users/shaun/Library/Application Support/bond/library',
  skillsDir: '/Users/shaun/.bond/skills',
  now: '2026-07-21T18:00:00.000Z',
}

const AUDIT_DOC = `${deps.libraryDir}/058eb00f-4d8c-4bb2-93c4-a4aaa16e7290.md`

beforeEach(() => {
  resetReadCountsForTest()
})

describe('workingPatchFromToolEvent', () => {
  it('captures a library document written by the write tool', () => {
    const patch = workingPatchFromToolEvent({ toolName: 'write', args: { path: AUDIT_DOC, content: '# Studio trunk audit' } }, deps)
    expect(patch?.artifacts).toEqual([{ kind: 'library', ref: AUDIT_DOC, lastTouchedAt: deps.now }])
  })

  it('captures an edited project file as a plain file', () => {
    const patch = workingPatchFromToolEvent({ toolName: 'edit', args: { path: '/Users/shaun/Developer/Projects/bond/src/daemon/agent.ts', edits: [] } }, deps)
    expect(patch?.artifacts?.[0]).toMatchObject({ kind: 'file', ref: '/Users/shaun/Developer/Projects/bond/src/daemon/agent.ts' })
  })

  it('captures the active skill from a SKILL.md read', () => {
    const patch = workingPatchFromToolEvent({ toolName: 'read', args: { path: `${deps.skillsDir}/audit-triage-feedback/SKILL.md` } }, deps)
    expect(patch).toEqual({ activeSkill: 'audit-triage-feedback' })
  })

  it('ignores a nested file inside a skill directory', () => {
    const patch = workingPatchFromToolEvent({ toolName: 'read', args: { path: `${deps.skillsDir}/audit-triage-feedback/references/notes.md` } }, deps)
    expect(patch).toBeNull()
  })

  it('captures a file only on the second read', () => {
    const event = { toolName: 'read', args: { path: '/Users/shaun/notes.md' } }
    expect(workingPatchFromToolEvent(event, deps)).toBeNull()
    expect(workingPatchFromToolEvent(event, deps)?.artifacts?.[0]).toMatchObject({ kind: 'file', ref: '/Users/shaun/notes.md' })
  })

  it('extracts a Linear issue key from a linear-flavored mcp call', () => {
    const patch = workingPatchFromToolEvent({
      toolName: 'mcp',
      args: { provider: 'linear', subtool: 'create-issue' },
      result: 'Created issue STU-2085: Remove session-library scans from New chat',
    }, deps)
    expect(patch?.artifacts).toEqual([{ kind: 'issue', ref: 'STU-2085', lastTouchedAt: deps.now }])
  })

  it('does not mine issue keys out of unrelated mcp calls', () => {
    // A bare [A-Z]{2,6}-\d+ over arbitrary output matches prose like "UTF-8".
    const patch = workingPatchFromToolEvent({
      toolName: 'mcp',
      args: { provider: 'slack', subtool: 'search' },
      result: 'The file is UTF-8 encoded and ISO-8601 timestamped.',
    }, deps)
    expect(patch).toBeNull()
  })

  it('ignores bash, grep, and errored tools', () => {
    expect(workingPatchFromToolEvent({ toolName: 'bash', args: { command: 'ls' } }, deps)).toBeNull()
    expect(workingPatchFromToolEvent({ toolName: 'grep', args: { path: '/tmp', pattern: 'x' } }, deps)).toBeNull()
    expect(workingPatchFromToolEvent({ toolName: 'write', args: { path: AUDIT_DOC }, isError: true }, deps)).toBeNull()
  })

  it('ignores a write with no usable path', () => {
    expect(workingPatchFromToolEvent({ toolName: 'write', args: { content: 'x' } }, deps)).toBeNull()
  })

  it('does not treat a sibling directory as being inside the library', () => {
    const patch = workingPatchFromToolEvent({ toolName: 'write', args: { path: `${deps.libraryDir}-backup/x.md` } }, deps)
    expect(patch?.artifacts?.[0].kind).toBe('file')
  })
})
