/**
 * Client-side reveal for Bond's seeded first-run intro. The intro is static
 * text, not a model stream, but it must be indistinguishable from one: real
 * streaming arrives as bursty word-chunks, while a constant per-character
 * crawl — at any speed — reads as a deliberate typewriter animation. So the
 * reveal emits whole words in small bursts on a ~30ms cadence (~330 chars/sec
 * overall, model-stream pace) through the same rAF-throttled MarkdownMessage
 * path streaming uses.
 *
 * Progress is anchored to wall-clock time so Chromium's background timer
 * throttling (~1Hz while the window is occluded) can never stall the reveal:
 * every wake-up emits everything that should be visible by now.
 *
 * Text reveal is not "motion" — it must NOT be gated on prefers-reduced-motion.
 */
export async function playTypewriter(
  text: string,
  onUpdate: (partial: string) => void,
  msPerChar = 3
): Promise<void> {
  if (!text) return
  // End of each word including its trailing whitespace run — every emitted
  // prefix lands on a word boundary, never mid-word.
  const wordEnds: number[] = []
  const words = /\S+\s*/g
  for (let match = words.exec(text); match; match = words.exec(text)) {
    wordEnds.push(match.index + match[0].length)
  }
  const start = performance.now()
  let shownWords = 0
  while (shownWords < wordEnds.length) {
    await new Promise(resolve => setTimeout(resolve, 30))
    const earnedChars = (performance.now() - start) / msPerChar
    let next = shownWords
    while (next < wordEnds.length && wordEnds[next] <= earnedChars) next++
    shownWords = Math.max(next, shownWords + 1)
    onUpdate(text.slice(0, wordEnds[shownWords - 1]))
  }
}
