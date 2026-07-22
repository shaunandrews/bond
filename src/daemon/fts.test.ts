import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { buildMatchQuery, countMatchTerms } from './fts'

describe('buildMatchQuery', () => {
  it('quotes plain terms', () => {
    expect(buildMatchQuery('hello world')).toBe('"hello" "world"')
  })

  it('adds a per-term prefix star when asked', () => {
    expect(buildMatchQuery('hello world', { prefix: true })).toBe('"hello"* "world"*')
  })

  it('keeps hyphenated tokens as one quoted phrase', () => {
    expect(buildMatchQuery('foo-bar')).toBe('"foo-bar"')
  })

  it('neutralizes FTS5 operators into quoted literals', () => {
    expect(buildMatchQuery('a OR b')).toBe('"a" "OR" "b"')
    expect(buildMatchQuery('NEAR(')).toBe('"NEAR"')
    expect(buildMatchQuery('col:')).toBe('"col"')
    expect(buildMatchQuery('"quoted"')).toBe('"quoted"')
    expect(buildMatchQuery('"unbalanced')).toBe('"unbalanced"')
  })

  it('keeps a quoted span as one phrase term', () => {
    // The model quoted "on to 9" expecting phrase matching; the old builder
    // flattened it into three independent AND terms and matched nothing.
    expect(buildMatchQuery('"on to 9" Studio audit')).toBe('"on to 9" "Studio" "audit"')
    expect(buildMatchQuery('"multi word phrase"')).toBe('"multi word phrase"')
  })

  it('sanitizes phrase interiors instead of trusting them', () => {
    expect(buildMatchQuery('"NEAR( col: x"')).toBe('"NEAR col x"')
    expect(buildMatchQuery('"***"')).toBeNull()
    expect(buildMatchQuery('"a-b c_d"')).toBe('"a-b c_d"')
  })

  it('never prefix-stars a phrase', () => {
    expect(buildMatchQuery('"two words" solo', { prefix: true })).toBe('"two words" "solo"*')
  })

  it('joins with OR in or mode', () => {
    expect(buildMatchQuery('studio trunk audit', { mode: 'or' })).toBe('"studio" OR "trunk" OR "audit"')
    expect(buildMatchQuery('"on to 9" audit', { mode: 'or' })).toBe('"on to 9" OR "audit"')
  })

  it('dedupes repeated terms', () => {
    expect(buildMatchQuery('audit audit AUDIT')).toBe('"audit"')
  })

  it('counts terms for callers deciding whether to broaden', () => {
    expect(countMatchTerms('"on to 9" Studio audit')).toBe(3)
    expect(countMatchTerms('audit')).toBe(1)
    expect(countMatchTerms('!!!')).toBe(0)
  })

  it('caps the number of terms', () => {
    expect(buildMatchQuery('a b c d e f g h i j')).toBe('"a" "b" "c" "d" "e" "f" "g" "h"')
    expect(buildMatchQuery('a b c', { maxTerms: 2 })).toBe('"a" "b"')
  })

  it('returns null when nothing is indexable', () => {
    for (const q of ['', '   ', '*', '???', '::', '()', '🎉🎉', '!@#$%^&*']) {
      expect(buildMatchQuery(q), `query ${JSON.stringify(q)}`).toBeNull()
      expect(buildMatchQuery(q, { prefix: true }), `query ${JSON.stringify(q)} (prefix)`).toBeNull()
    }
  })

  it('never produces a MATCH string FTS5 rejects, with and without prefix', () => {
    const db = new Database(':memory:')
    db.exec('CREATE VIRTUAL TABLE t USING fts5(text)')
    db.prepare('INSERT INTO t (text) VALUES (?)').run('some indexed content for smoke testing')

    const hostile = [
      'foo-bar',
      '"quoted"',
      'NEAR(',
      'a OR b',
      '*',
      'col:',
      '"unbalanced',
      '🎉',
      '',
      'AND NOT OR',
      'a*b',
      '(paren) grouping',
      'MATCH match',
      '-leading dash-',
      'ünïcode nörmâl',
      '日本語 テスト',
      '"on to 9" studio',
      '"NEAR(" col:',
      '"unclosed phrase',
      '""',
      '"a" OR "b"',
    ]

    for (const q of hostile) {
      for (const prefix of [false, true]) {
        for (const mode of ['and', 'or'] as const) {
        const match = buildMatchQuery(q, { prefix, mode })
        if (match === null) continue
        expect(
          () => db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(match),
          `query ${JSON.stringify(q)} prefix=${prefix} mode=${mode} built ${JSON.stringify(match)}`
        ).not.toThrow()
        }
      }
    }
  })

  it('prefix mode matches word prefixes, approximating LIKE substring recall', () => {
    const db = new Database(':memory:')
    db.exec('CREATE VIRTUAL TABLE t USING fts5(text)')
    db.prepare('INSERT INTO t (text) VALUES (?)').run('release of the foo-bar toolkit')

    expect(db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(buildMatchQuery('foo-bar', { prefix: true })!)).toHaveLength(1)
    expect(db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(buildMatchQuery('tool', { prefix: true })!)).toHaveLength(1)
    expect(db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(buildMatchQuery('tool', { prefix: false })!)).toHaveLength(0)
  })
})
