/**
 * Copy text that also works in insecure contexts. The web client runs over
 * plain http on a LAN IP, where navigator.clipboard is undefined — same
 * constraint as the uid() fallback in useChat. Falls back to the hidden
 * textarea + execCommand('copy') technique.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* permission denied or transient failure — try the fallback */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}
