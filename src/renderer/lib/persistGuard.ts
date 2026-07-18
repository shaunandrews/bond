/**
 * Guard for transcript persistence on page unload.
 *
 * The main process sets `window.__bondSuppressPersist` synchronously (via an
 * awaited executeJavaScript) immediately BEFORE swapping the daemon's data
 * directory for the new-user sandbox. Without it, the dying page's
 * beforeunload persist fires against the post-swap data set and leaks the real
 * transcript into the sandbox (or vice versa). The `sandboxed` flag covers the
 * steady state; the window flag covers the swap itself.
 */
export function shouldPersistOnUnload(sandboxed: boolean): boolean {
  if (sandboxed) return false
  return !(window as { __bondSuppressPersist?: boolean }).__bondSuppressPersist
}
