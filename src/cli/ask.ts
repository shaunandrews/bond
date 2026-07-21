#!/usr/bin/env node

/**
 * bond ask — show and answer Bond's pending ask_user_question, if any.
 *
 * Usage:
 *   bond ask                  Show the pending question; prompt interactively if a TTY
 *   bond ask 2                Answer with option 2
 *   bond ask --text "..."     Answer with custom text
 *   bond ask --cancel         Dismiss the question
 *   bond ask --json           Print the pending question as JSON and exit (never prompts)
 */

import { createInterface } from 'node:readline'
import { call, connect, type WebSocket } from './connect'
import type { PendingQuestion, QuestionAnswer } from '../shared/questions'
import { answerFromArgs, formatQuestionBlock, parseAnswerLine, parseAskArgs } from './ask-helpers'

const D = '\x1b[0;90m'
const N = '\x1b[0m'
const G = '\x1b[0;32m'

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (line) => {
      rl.close()
      resolve(line)
    })
    rl.on('SIGINT', () => {
      rl.close()
      resolve('')
    })
  })
}

function describeAnswer(answer: QuestionAnswer): string {
  if (answer.kind === 'option') return `${G}Answered: ${answer.number}. ${answer.label}${N}`
  if (answer.kind === 'custom') return `${G}Answered: "${answer.text}"${N}`
  return `${D}Dismissed.${N}`
}

async function main() {
  const args = process.argv.slice(2)
  const parsed = parseAskArgs(args)

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error('Cannot connect to Bond daemon. Is it running?')
    process.exit(1)
  }

  try {
    const pending = await call(ws, 'question.pending') as PendingQuestion | null
    if (!pending) {
      console.log(`${D}No pending question.${N}`)
      return
    }

    if (parsed.mode === 'json') {
      console.log(JSON.stringify(pending, null, 2))
      return
    }

    let answer = answerFromArgs(parsed, pending.options)
    if (!answer && parsed.mode !== 'show') {
      console.error(`No option ${parsed.mode === 'option' ? `#${parsed.number}` : ''} on the pending question.`)
      process.exit(1)
    }

    if (!answer) {
      // A non-interactive caller (script, cron) must never block on stdin —
      // give it the same JSON an explicit --json would, and exit clean.
      if (!process.stdin.isTTY) {
        console.log(JSON.stringify(pending, null, 2))
        return
      }
      console.log(formatQuestionBlock(pending))
      const line = await readLine('> ')
      answer = parseAnswerLine(line, pending.options)
    }

    await call(ws, 'bond.questionResponse', { questionId: pending.questionId, answer })
    console.log(describeAnswer(answer))
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
