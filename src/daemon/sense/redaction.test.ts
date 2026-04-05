import { describe, it, expect } from 'vitest'
import { redact } from './redaction'

describe('redaction', () => {
  it('redacts AWS access keys', () => {
    const text = 'key is AKIAIOSFODNN7EXAMPLE'
    expect(redact(text)).toBe('key is [REDACTED_API_KEY]')
  })

  it('redacts GitHub tokens', () => {
    expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn')).toContain('[REDACTED_API_KEY]')
  })

  it('redacts Stripe keys', () => {
    expect(redact('sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZab')).toContain('[REDACTED_API_KEY]')
  })

  it('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.sig'
    const result = redact(text)!
    expect(result).toContain('[REDACTED_TOKEN]')
  })

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(redact(jwt)).toBe('[REDACTED_TOKEN]')
  })

  it('redacts password patterns', () => {
    expect(redact('password: mysecretpass123')).toContain('[REDACTED]')
    expect(redact('api_key=abc123def456')).toContain('[REDACTED]')
    expect(redact('secret = "verysecret"')).toContain('[REDACTED]')
  })

  it('redacts URLs with embedded credentials', () => {
    const text = 'https://user:password@example.com/api'
    expect(redact(text)).toContain('[REDACTED]@')
    expect(redact(text)).not.toContain('password@')
  })

  it('redacts SSN patterns', () => {
    expect(redact('SSN: 123-45-6789')).toContain('[REDACTED_SSN]')
  })

  it('drops frames with Luhn-valid card numbers and payment keywords', () => {
    // 4532015112830366 is a Luhn-valid test card number
    const text = 'credit card number: 4532015112830366'
    expect(redact(text)).toBeNull()
  })

  it('does not drop frames with card-like numbers without payment keywords', () => {
    const text = 'ID: 4532015112830366'
    // Luhn-valid but no payment keywords — redact but don't drop
    expect(redact(text)).not.toBeNull()
  })

  it('preserves normal text', () => {
    const text = 'This is a normal code comment with no secrets'
    expect(redact(text)).toBe(text)
  })

  it('handles multiple patterns in one text', () => {
    const text = 'key=AKIAIOSFODNN7EXAMPLE and password: secret123'
    const result = redact(text)!
    expect(result).toContain('[REDACTED_API_KEY]')
    expect(result).toContain('[REDACTED]')
  })
})
