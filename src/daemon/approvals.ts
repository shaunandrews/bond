/**
 * The single registry for pending tool approvals.
 *
 * Id spaces: `requestId` (random UUID minted per prompt) is the resolution
 * key; `turnId` is the bulk-clear scope so an aborted or finished turn denies
 * everything it left parked. No sessionId anywhere — the legacy per-session
 * keying left three registries in three id spaces, only one of them live.
 */
export type ApprovalResult = { approved: boolean; input?: Record<string, unknown> }

type PendingApproval = { turnId: string; resolve: (result: ApprovalResult) => void }

const pending = new Map<string, PendingApproval>()

/** Park an approval until a human answers (or the turn is cleared). */
export function registerApproval(requestId: string, turnId: string): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    pending.set(requestId, { turnId, resolve })
  })
}

/** Answer a parked approval. Returns false when the id is unknown (already resolved or cleared). */
export function resolveApproval(requestId: string, approved: boolean, input?: Record<string, unknown>): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  entry.resolve({ approved, input })
  return true
}

/** Deny and drop every approval parked by the given turn. */
export function clearTurnApprovals(turnId: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.turnId === turnId) {
      pending.delete(requestId)
      entry.resolve({ approved: false })
    }
  }
}

/** Turn ids with at least one parked approval (introspection/tests). */
export function pendingApprovalTurnIds(): string[] {
  return [...new Set([...pending.values()].map((entry) => entry.turnId))]
}
