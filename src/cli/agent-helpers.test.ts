import { describe, expect, it } from 'vitest'
import { formatAgentEvents, parseAgentArgs } from './agent-helpers'

describe('bond agent CLI helpers', () => {
  it('parses every operational command without treating missing answers as denial', () => {
    expect(parseAgentArgs(['status', 'run-1', '--json'])).toEqual({ kind: 'status', runId: 'run-1', json: true })
    expect(parseAgentArgs(['logs', 'run-1'])).toMatchObject({ kind: 'logs', runId: 'run-1' })
    expect(parseAgentArgs(['cancel', 'run-1'])).toEqual({ kind: 'cancel', runId: 'run-1' })
    expect(parseAgentArgs(['discard', 'run-1'])).toEqual({ kind: 'discard', runId: 'run-1' })
    expect(parseAgentArgs(['answer', 'run-1', 'q1'])).toMatchObject({ kind: 'answer', approved: null })
    expect(parseAgentArgs(['answer', 'run-1', 'q1', 'yes', '--response', 'needed'])).toMatchObject({ approved: true, response: 'needed' })
  })

  it('renders append-only event lines', () => {
    const rendered = formatAgentEvents([{ id: 1, runId: 'r', sequence: 2, type: 'retry_scheduled', fromState: 'running', toState: 'interrupted', data: { retryNumber: 1, authorization: 'github_pat_abcdefghijklmnopqrstuvwxyz' }, createdAt: '2026-01-01T00:00:00.000Z' }])
    expect(rendered).toContain('retry_scheduled')
    expect(rendered).toContain('[REDACTED]')
    expect(rendered).not.toContain('github_pat_')
  })
})
