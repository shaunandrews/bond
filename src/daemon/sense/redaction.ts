/**
 * Regex-based security redaction for extracted text.
 * Scans for passwords, API keys, tokens, card numbers, SSNs.
 * Returns null if the entire frame should be dropped (e.g. payment data).
 */

const PATTERNS: { regex: RegExp; replacement: string }[] = [
  // AWS keys
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_API_KEY]' },
  // GitHub tokens
  { regex: /gh[ps]_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_API_KEY]' },
  { regex: /github_pat_[A-Za-z0-9_]{82}/g, replacement: '[REDACTED_API_KEY]' },
  // Stripe keys
  { regex: /[sr]k_(test|live)_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_API_KEY]' },
  // OpenAI / Anthropic keys
  { regex: /sk-[A-Za-z0-9-_]{40,}/g, replacement: '[REDACTED_API_KEY]' },
  // Slack tokens
  { regex: /xox[bpras]-[A-Za-z0-9-]+/g, replacement: '[REDACTED_API_KEY]' },
  // Generic API key patterns
  { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}["']?/gi, replacement: '[REDACTED_API_KEY]' },
  // api_key=value (without space)
  { regex: /(?:api_key|api-key)\s*=\s*[A-Za-z0-9_\-]{6,}/gi, replacement: '[REDACTED]' },
  // Bearer tokens
  { regex: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g, replacement: 'Bearer [REDACTED_TOKEN]' },
  // JWTs
  { regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-+/=]+/g, replacement: '[REDACTED_TOKEN]' },
  // Password patterns
  { regex: /(?:password|passwd|secret|token)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: '[REDACTED]' },
  // URLs with embedded credentials
  { regex: /https?:\/\/[^:]+:[^@]+@/g, replacement: 'https://[REDACTED]@' },
  // SSN patterns
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
]

// Luhn algorithm for credit card validation
function isLuhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10)
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// Credit card number pattern (13-19 digits, optionally separated by spaces/dashes)
const CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g

// Payment-related keywords
const PAYMENT_KEYWORDS = /\b(?:card\s*number|credit\s*card|debit\s*card|cvv|expir|billing)\b/i

/**
 * Redacts sensitive content from text.
 * Returns the redacted text, or null if the entire frame should be dropped.
 */
export function redact(text: string): string | null {
  // Check for credit card numbers — drop entire frame
  const potentialCards = text.match(CARD_PATTERN)
  if (potentialCards) {
    for (const match of potentialCards) {
      const digits = match.replace(/[^0-9]/g, '')
      if (digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits)) {
        // Luhn-valid card number + payment keywords = drop frame
        if (PAYMENT_KEYWORDS.test(text)) return null
      }
    }
  }

  // Apply pattern-based redaction
  let result = text
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement)
  }

  return result
}
