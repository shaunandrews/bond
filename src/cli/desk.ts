#!/usr/bin/env node

/**
 * bond desk — what's on your desk.
 *
 * This is not optional tooling: it is the only way the Phase 2 go/no-go can
 * happen. The daemon half ships before any UI exists, so `status`, `blocks`,
 * and above all `stats` are where a day of dogfooding turns into a decision
 * instead of an impression.
 *
 *   bond desk                      Status
 *   bond desk on | off             Start/stop observing
 *   bond desk blocks [--day D]     Blocks for a day
 *   bond desk threads [--all]      Thread catalogue
 *   bond desk matchers [--all]     The rules editor, in text
 *   bond desk answer [id] yes|no   Answer the pending Ask
 *   bond desk stats [--hours N]    Inference instrumentation
 */

import { call, connect } from './connect'
import {
  DESK_HELP,
  dayRange,
  formatBlocks,
  formatMatchers,
  formatStats,
  formatStatus,
  formatThreads,
  parseDeskArgs,
} from './desk-helpers'
import { localDay } from '../shared/desk'
import type { DeskBlockDetail, DeskMatcher, DeskStats, DeskStatus, DeskThread } from '../shared/desk'

async function main(): Promise<void> {
  const parsed = parseDeskArgs(process.argv.slice(2))

  if (parsed.kind === 'help') {
    console.log(DESK_HELP)
    return
  }
  if (parsed.kind === 'unknown') {
    console.error(`Unknown desk command: ${parsed.command}\n`)
    console.log(DESK_HELP)
    process.exit(1)
  }

  const ws = await connect()
  try {
    switch (parsed.kind) {
      case 'status':
        console.log(formatStatus(await call(ws, 'desk.status') as DeskStatus))
        break

      case 'on':
      case 'off': {
        const status = await call(ws, 'desk.setRunning', { running: parsed.kind === 'on' }) as DeskStatus
        console.log(formatStatus(status))
        break
      }

      case 'blocks': {
        const range = dayRange(parsed.day ?? localDay())
        const blocks = await call(ws, 'desk.blocks', { ...range, limit: parsed.limit }) as DeskBlockDetail[]
        console.log(formatBlocks(blocks))
        break
      }

      case 'threads':
        console.log(formatThreads(
          await call(ws, 'desk.threads', { includeArchived: parsed.includeArchived }) as DeskThread[]
        ))
        break

      case 'matchers':
        console.log(formatMatchers(
          await call(ws, 'desk.matchers', { confirmedOnly: parsed.confirmedOnly }) as DeskMatcher[]
        ))
        break

      case 'answer': {
        let questionId = parsed.questionId
        if (!questionId) {
          const status = await call(ws, 'desk.status') as DeskStatus
          questionId = status.pendingQuestion?.id ?? null
        }
        if (!questionId) {
          console.log('No pending question.')
          break
        }
        const result = await call(ws, 'desk.answer', { questionId, accepted: parsed.accepted }) as { ok: boolean }
        console.log(result.ok
          ? (parsed.accepted ? 'Accepted.' : 'Rejected — and Desk will stop suggesting that pairing.')
          : 'That question is no longer pending.')
        break
      }

      case 'stats':
        console.log(formatStats(await call(ws, 'desk.stats', { windowHours: parsed.windowHours }) as DeskStats))
        break
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
