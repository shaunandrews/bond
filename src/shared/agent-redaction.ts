const REDACTED = '[REDACTED]'

const SECRET_PATTERNS = [
  /\b(?:github_pat|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
]

export function redactAgentText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}${REDACTED}`), value)
}

export function redactAgentValue<T>(value: T): T {
  if (typeof value === 'string') return redactAgentText(value) as T
  if (Array.isArray(value)) return value.map(redactAgentValue) as T
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = /^(?:token|accessToken|authToken|credential|credentialRef|secret|password|authorization|apiKey|api_key)$/i.test(key)
        ? REDACTED
        : redactAgentValue(entry)
    }
    return output as T
  }
  return value
}
