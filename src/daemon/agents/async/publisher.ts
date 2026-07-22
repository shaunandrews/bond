/**
 * Remote publishing boundary for the next tranche. The local Mathis runtime
 * never imports a GitHub SDK, reads credentials, or invokes git/gh remotes.
 */
export interface DraftPublishRequest {
  runId: string
  repository: string
  baseRef: string
  headRef: string
  title: string
  body: string
  idempotencyKey: string
}

export interface DraftPublishResult {
  provider: 'github-app'
  externalId: string
  url: string
  draft: true
}

export interface AgentRunPublisher {
  publishDraft(request: DraftPublishRequest): Promise<DraftPublishResult>
}

export const disabledAgentRunPublisher: AgentRunPublisher = {
  async publishDraft(): Promise<DraftPublishResult> {
    throw new Error('Remote agent-run publishing is not configured in this tranche.')
  },
}
