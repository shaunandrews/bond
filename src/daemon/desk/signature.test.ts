import { describe, it, expect } from 'vitest'
import {
  buildEvidence,
  computeSpecificity,
  extractPaths,
  isGenericBundle,
  mergeEvidence,
  normalizeTitle,
  redactAll,
  redactField,
  resourceSignature,
  signatureForCapture,
  tooBroadReason,
  type CaptureRow,
} from './signature'

function capture(overrides: Partial<CaptureRow> = {}): CaptureRow {
  return {
    id: 'c1',
    captured_at: '2026-07-20T10:00:00.000Z',
    app_name: 'Studio',
    app_bundle_id: 'com.automattic.studio',
    window_title: 'Studio — Sync Dialog',
    text_content: null,
    text_status: 'done',
    image_path: '/tmp/a.jpg',
    image_purged_at: null,
    ...overrides,
  }
}

describe('normalizeTitle', () => {
  it('strips notification counters so Inbox (3) and Inbox (7) are one resource', () => {
    expect(normalizeTitle('Inbox (3) — Mail')).toBe(normalizeTitle('Inbox (7) — Mail'))
  })

  it('strips the unsaved-changes dot', () => {
    expect(normalizeTitle('SyncDialog.tsx •')).toBe(normalizeTitle('SyncDialog.tsx'))
  })

  it('strips clocks and progress suffixes', () => {
    expect(normalizeTitle('Render 10:32 PM')).toBe('render')
    expect(normalizeTitle('Export — 42%')).toBe('export')
  })

  it('collapses casing and whitespace drift', () => {
    expect(normalizeTitle('  Studio   Sync  ')).toBe('studio sync')
    expect(normalizeTitle('STUDIO SYNC')).toBe('studio sync')
  })
})

describe('redactField', () => {
  it('scrubs a token out of a window title', () => {
    const out = redactField('Terminal — export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).not.toContain('ghp_abcdefghijklmnop')
    expect(out).toContain('[REDACTED')
  })

  it('scrubs an api_key query string out of a browser title', () => {
    const out = redactField('Dashboard api_key=sk-012345678901234567890123456789012345678901234567')
    expect(out).not.toContain('sk-0123456789012345678901')
  })

  it('drops the title, not the segment, when redaction rejects the whole string', () => {
    // A Luhn-valid card plus payment keywords makes redact() return null.
    expect(redactField('Billing — card number 4111 1111 1111 1111')).toBeNull()
  })

  it('returns null for empty and whitespace-only input', () => {
    expect(redactField('')).toBeNull()
    expect(redactField('   ')).toBeNull()
    expect(redactField(null)).toBeNull()
    expect(redactField(undefined)).toBeNull()
  })

  it('leaves an ordinary title alone', () => {
    expect(redactField('Studio — Sync Dialog')).toBe('Studio — Sync Dialog')
  })
})

describe('redactAll', () => {
  it('dedupes and drops rejected entries', () => {
    const out = redactAll(['A', 'A', null, '', 'Billing — card number 4111 1111 1111 1111', 'B'])
    expect(out).toEqual(['A', 'B'])
  })
})

describe('extractPaths', () => {
  it('only reads paths out of structured accessibility evidence', () => {
    const text = 'open ~/Developer/Projects/bond/src/daemon/desk/store.ts now'
    expect(extractPaths(text, 'accessibility')).toContain('~/Developer/Projects/bond/src/daemon/desk/store.ts')
    expect(extractPaths(text, 'both')).not.toHaveLength(0)
    // OCR soup is not a path source — a mis-read character would fork the signature
    expect(extractPaths(text, 'ocr')).toEqual([])
    expect(extractPaths(text, null)).toEqual([])
    expect(extractPaths(null, 'accessibility')).toEqual([])
  })
})

describe('resourceSignature', () => {
  it('is stable across volatile title churn', () => {
    const a = resourceSignature({ bundleId: 'com.apple.Mail', appName: 'Mail', title: 'Inbox (3)' })
    const b = resourceSignature({ bundleId: 'com.apple.mail', appName: 'Mail', title: 'Inbox (12)' })
    expect(a).toBe(b)
  })

  it('separates different resources in the same app', () => {
    const a = resourceSignature({ bundleId: 'com.automattic.studio', appName: 'Studio', title: 'Sync Dialog' })
    const b = resourceSignature({ bundleId: 'com.automattic.studio', appName: 'Studio', title: 'Settings' })
    expect(a).not.toBe(b)
  })

  it('is an opaque hash, so a suppression never carries the captured title', () => {
    const sig = resourceSignature({ bundleId: 'com.apple.mail', appName: 'Mail', title: 'Secret Project Kickoff' })
    expect(sig).toMatch(/^[0-9a-f]{32}$/)
    expect(sig.toLowerCase()).not.toContain('secret')
  })

  it('falls back to the app name when there is no bundle id', () => {
    expect(resourceSignature({ bundleId: null, appName: 'Studio', title: 'x' }))
      .toBe(resourceSignature({ bundleId: null, appName: 'studio', title: 'x' }))
  })

  it('folds path order so evidence ordering cannot fork it', () => {
    const a = resourceSignature({ bundleId: 'b', appName: null, title: 't', paths: ['~/a.ts', '~/b.ts'] })
    const b = resourceSignature({ bundleId: 'b', appName: null, title: 't', paths: ['~/b.ts', '~/a.ts'] })
    expect(a).toBe(b)
  })
})

describe('buildEvidence', () => {
  it('persists only redacted titles', () => {
    const evidence = buildEvidence(capture({ window_title: 'Deploy Bearer abc123def456ghi789' }))
    expect(evidence.titles?.[0]).toContain('[REDACTED_TOKEN]')
  })

  it('omits a title redaction rejected outright', () => {
    const evidence = buildEvidence(capture({ window_title: 'Billing — card number 4111 1111 1111 1111' }))
    expect(evidence.titles).toBeUndefined()
    // the segment still has its app identity
    expect(evidence.bundleId).toBe('com.automattic.studio')
  })

  it('captures accessibility paths but not OCR ones', () => {
    const text = 'editing ~/Developer/Projects/bond/src/main/desk.ts'
    expect(buildEvidence(capture({ text_content: text }), 'accessibility').paths).toHaveLength(1)
    expect(buildEvidence(capture({ text_content: text }), 'ocr').paths).toBeUndefined()
  })
})

describe('signatureForCapture', () => {
  it('signs the redacted title, never the raw one', () => {
    const raw = 'Terminal — ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const fromCapture = signatureForCapture(capture({ window_title: raw }))
    const fromRedacted = resourceSignature({
      bundleId: 'com.automattic.studio',
      appName: 'Studio',
      title: redactField(raw),
    })
    expect(fromCapture).toBe(fromRedacted)
    expect(fromCapture).not.toBe(resourceSignature({
      bundleId: 'com.automattic.studio', appName: 'Studio', title: raw,
    }))
  })
})

describe('mergeEvidence', () => {
  it('unions and bounds titles and paths', () => {
    const merged = mergeEvidence(
      { appName: 'Studio', titles: ['a', 'b'] },
      { titles: ['b', 'c'], paths: ['~/x.ts'] }
    )
    expect(merged.titles).toEqual(['a', 'b', 'c'])
    expect(merged.paths).toEqual(['~/x.ts'])
    expect(merged.appName).toBe('Studio')
  })

  it('caps titles at six and paths at eight', () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const merged = mergeEvidence({ titles: many }, { paths: many })
    expect(merged.titles).toHaveLength(6)
    expect(merged.paths).toHaveLength(8)
  })
})

describe('isGenericBundle', () => {
  it('flags the apps a correction must never turn into a bundle-wide rule', () => {
    for (const id of ['com.google.Chrome', 'com.apple.Terminal', 'com.apple.Finder', 'com.tinyspeck.slackmacgap']) {
      expect(isGenericBundle(id)).toBe(true)
    }
  })

  it('does not flag a purpose-built app', () => {
    expect(isGenericBundle('com.automattic.studio')).toBe(false)
    expect(isGenericBundle(null)).toBe(false)
  })
})

describe('tooBroadReason', () => {
  it('rejects the patterns that actually showed up in real inference output', () => {
    // Every one of these was written to a live database and mis-attributed work.
    expect(tooBroadReason('title', '~')).toBeTruthy()
    expect(tooBroadReason('title', 'Bond')).toBeTruthy()
    expect(tooBroadReason('title', 'codex')).toBeTruthy()
    expect(tooBroadReason('bundle', 'Claude')).toBeTruthy()
    expect(tooBroadReason('title', 'Studio')).toBeTruthy()
  })

  it('rejects punctuation-only patterns', () => {
    for (const pattern of ['~/', '///////', '.........', '---------- ']) {
      expect(tooBroadReason('title', pattern)).toBeTruthy()
    }
  })

  it('rejects an empty or whitespace pattern', () => {
    expect(tooBroadReason('title', '')).toBeTruthy()
    expect(tooBroadReason('title', '     ')).toBeTruthy()
  })

  it('accepts a genuinely distinctive title', () => {
    expect(tooBroadReason('title', 'Studio — Sync Dialog')).toBeNull()
    expect(tooBroadReason('title', 'Dave Matthews Setlist')).toBeNull()
  })

  it('accepts a concrete repository path', () => {
    expect(tooBroadReason('path', '/Developer/Projects/bond')).toBeNull()
  })

  it('rejects a bundle rule for a generic app', () => {
    expect(tooBroadReason('bundle', 'com.google.Chrome')).toMatch(/covers too much/)
    expect(tooBroadReason('bundle', 'com.mitchellh.ghostty')).toMatch(/covers too much/)
  })

  it('accepts a bundle rule for a purpose-built app', () => {
    expect(tooBroadReason('bundle', 'com.automattic.studio')).toBeNull()
  })

  it('rejects a display name masquerading as a bundle id', () => {
    expect(tooBroadReason('bundle', 'Ghostty Terminal')).toMatch(/not a bundle identifier/)
  })

  it('rejects a title matcher that is just the app name', () => {
    expect(tooBroadReason('title', 'Studio Workbench', { appName: 'Studio Workbench' }))
      .toMatch(/just the app name/)
  })

  it('rejects a single word inside a generic app — a bundle rule in disguise', () => {
    expect(tooBroadReason('title', 'bondbondbond', { bundleId: 'com.mitchellh.ghostty' }))
      .toMatch(/single word inside a generic app/)
    // ...but a multi-word title in the same app is fine
    expect(tooBroadReason('title', '~/Developer/Projects/bond — nvim', { bundleId: 'com.mitchellh.ghostty' }))
      .toBeNull()
  })
})

describe('computeSpecificity', () => {
  it('ranks exact over prefix over contains', () => {
    expect(computeSpecificity('exact', 'abc')).toBeGreaterThan(computeSpecificity('prefix', 'abc'))
    expect(computeSpecificity('prefix', 'abc')).toBeGreaterThan(computeSpecificity('contains', 'abc'))
  })

  it('ranks a longer pattern above a shorter one of the same operator', () => {
    expect(computeSpecificity('prefix', 'studio — sync')).toBeGreaterThan(computeSpecificity('prefix', 'studio'))
  })
})
