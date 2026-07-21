/**
 * open_desk — Bond's own Pi tool for revealing the Desk panel.
 *
 * *"let's get to work"* should be the real agent deciding, not a string match,
 * so this is a tool rather than a phrase trigger. It is deliberately NOT
 * onboarding's `show_panel`: Desk is a separate non-activating window owned by
 * the main process, and it has two states `show_panel` has no way to express.
 *
 *  - **Sense disabled** — Desk still opens, showing historical threads and
 *    Today, in a non-recording state with an Enable Sense action. The tool says
 *    so plainly rather than implying observation is happening.
 *  - **Back-fill pending** — the tool returns `queued: true` and main opens
 *    only once `desk.status` reports populated or definitively empty. An empty
 *    panel on first open is the failure mode this exists to avoid.
 *
 * A second call focuses nothing and simply reveals the existing window.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { BondStreamChunk } from '../../shared/stream'
import { getStatus, setRunning } from './service'
import { formatApproxDuration } from '../../shared/desk'

export const DESK_TOOL_NAMES = ['open_desk']

export interface DeskToolOptions {
  onChunk?: (chunk: BondStreamChunk) => void
  /** Injected in tests; production reads the real status. */
  readStatus?: typeof getStatus
  startRunning?: (running: boolean) => unknown
}

export function describeDeskState(status: ReturnType<typeof getStatus>): string {
  const lines: string[] = []

  if (!status.senseEnabled || status.senseState === 'disabled') {
    lines.push(
      'Desk is open, but Sense is off — so it is showing historical threads and Today only, and is not observing anything now. ' +
      'The panel offers an Enable Sense action; do not imply Bond is watching until they take it.'
    )
  } else if (status.senseState === 'paused' || status.senseState === 'suspended') {
    lines.push(`Desk is open. Sense is ${status.senseState}, so the current block stays open but its clock is stopped.`)
  } else {
    lines.push('Desk is open and observing.')
  }

  if (status.backfilling) {
    lines.push('Back-fill is still catching up on captures Sense already recorded; the panel will populate shortly.')
  }

  if (status.currentBlock?.thread) {
    lines.push(
      `Current thread: ${status.currentBlock.thread.name} (${formatApproxDuration(status.presenceSeconds)}). ` +
      'Times are approximate by design — never quote a precise figure back to the user.'
    )
  } else {
    lines.push('No current thread yet.')
  }

  if (status.pendingQuestion) {
    const subject = status.pendingQuestion.proposedThreadName ?? status.pendingQuestion.itemTitle
    if (subject) lines.push(`Desk is already asking about "${subject}" — do not ask the same thing in prose.`)
  }

  return lines.join(' ')
}

export function registerDeskTools(pi: ExtensionAPI, options: DeskToolOptions = {}): void {
  const readStatus = options.readStatus ?? getStatus
  const start = options.startRunning ?? ((running: boolean) => setRunning(running))

  pi.registerTool({
    name: 'open_desk',
    label: 'Open Desk',
    description:
      'Open Desk — the notch panel showing the work threads currently in flight, what each one was mid-way through, and today\'s todos. ' +
      'Use it when the user signals they are starting or resuming work ("let\'s get to work", "what was I doing", "where was I").',
    promptSnippet: 'Open Desk, the panel of work threads currently in flight',
    promptGuidelines: [
      'Call open_desk when the user signals they are starting or resuming work, not merely because they mentioned a task.',
      'Desk describes, it never grades — never report a productivity score, a streak, a daily total, or a comparison to yesterday from it.',
      'Desk times are approximate by design. Say "about an hour", never a precise figure.',
      'Calling open_desk twice is harmless — it reveals the existing panel rather than opening a second one.',
    ],
    parameters: Type.Object({}),
    async execute() {
      // Opening Desk is explicit intent, which is the only thing allowed to
      // turn it on. Observed activity never does.
      start(true)
      const status = readStatus()

      options.onChunk?.({
        kind: 'open_desk',
        queued: status.backfilling,
        senseEnabled: status.senseEnabled,
      })

      return {
        content: [{ type: 'text' as const, text: describeDeskState(status) }],
        details: {
          opened: true,
          queued: status.backfilling,
          senseEnabled: status.senseEnabled,
          senseState: status.senseState,
          currentThread: status.currentBlock?.thread?.name ?? null,
        },
      }
    },
  })
}

export function createDeskExtensionFactory(options: DeskToolOptions = {}) {
  return (pi: ExtensionAPI) => registerDeskTools(pi, options)
}
