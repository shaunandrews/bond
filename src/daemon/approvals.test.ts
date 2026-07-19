import { describe, it, expect } from 'vitest'
import { registerApproval, resolveApproval, clearTurnApprovals, pendingApprovalTurnIds } from './approvals'

describe('approvals registry', () => {
  it('resolves a registered approval by requestId', async () => {
    const parked = registerApproval('req-1', 'turn-a')
    expect(pendingApprovalTurnIds()).toContain('turn-a')

    expect(resolveApproval('req-1', true, { command: 'npm test' })).toBe(true)
    await expect(parked).resolves.toEqual({ approved: true, input: { command: 'npm test' } })
    expect(pendingApprovalTurnIds()).not.toContain('turn-a')
  })

  it('resolves a denial without input', async () => {
    const parked = registerApproval('req-2', 'turn-a')
    resolveApproval('req-2', false)
    await expect(parked).resolves.toEqual({ approved: false, input: undefined })
  })

  it('returns false for unknown request ids and double resolution', () => {
    registerApproval('req-3', 'turn-a')
    expect(resolveApproval('nope', true)).toBe(false)
    expect(resolveApproval('req-3', true)).toBe(true)
    expect(resolveApproval('req-3', true)).toBe(false)
  })

  it('clearTurnApprovals denies every pending approval for that turn only', async () => {
    const a1 = registerApproval('req-a1', 'turn-a')
    const a2 = registerApproval('req-a2', 'turn-a')
    const b1 = registerApproval('req-b1', 'turn-b')

    clearTurnApprovals('turn-a')

    await expect(a1).resolves.toEqual({ approved: false })
    await expect(a2).resolves.toEqual({ approved: false })
    expect(pendingApprovalTurnIds()).toEqual(['turn-b'])

    // The other turn's approval is still answerable.
    resolveApproval('req-b1', true)
    await expect(b1).resolves.toEqual({ approved: true, input: undefined })
  })
})
