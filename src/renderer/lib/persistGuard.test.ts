import { afterEach, describe, expect, it } from 'vitest'
import { shouldPersistOnUnload } from './persistGuard'

afterEach(() => {
  delete (window as { __bondSuppressPersist?: boolean }).__bondSuppressPersist
})

describe('shouldPersistOnUnload', () => {
  it('persists during normal, non-sandboxed operation', () => {
    expect(shouldPersistOnUnload(false)).toBe(true)
  })

  it('never persists while sandboxed', () => {
    expect(shouldPersistOnUnload(true)).toBe(false)
  })

  // Regression: entering the simulation swapped the daemon's data dir and THEN
  // reloaded; the old page (which still believed sandboxed=false) persisted the
  // real transcript into the sandbox DB, so the "fresh install" arrived full of
  // real chat history and first-run onboarding never triggered.
  it('never persists once main flags an imminent data swap, even if the page still thinks it is not sandboxed', () => {
    ;(window as { __bondSuppressPersist?: boolean }).__bondSuppressPersist = true
    expect(shouldPersistOnUnload(false)).toBe(false)
  })
})
