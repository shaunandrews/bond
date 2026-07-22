import { describe, expect, it } from 'vitest'
import { disabledAgentRunPublisher } from './publisher'

describe('agent run publishing boundary', () => {
  it('has no live remote implementation in the local Mathis tranche', async () => {
    await expect(disabledAgentRunPublisher.publishDraft({
      runId: 'run-1', repository: 'owner/bond', baseRef: 'main', headRef: 'bond-agent/run-1',
      title: 'Draft', body: 'Body', idempotencyKey: 'publish-run-1',
    })).rejects.toThrow('not configured')
  })
})
