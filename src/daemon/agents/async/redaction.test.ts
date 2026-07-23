import { describe, expect, it } from 'vitest'
import { redactAgentText, redactAgentValue } from './redaction'

describe('agent run redaction', () => {
  it('removes common credentials from text and nested durable data', () => {
    expect(redactAgentText('Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz')).not.toContain('github_pat_')
    expect(redactAgentValue({ output: 'api_key=sk-abcdefghijklmnopqrstuvwxyz', nested: { password: 'mine' } })).toEqual({
      output: 'api_key=[REDACTED]', nested: { password: '[REDACTED]' },
    })
  })
})
