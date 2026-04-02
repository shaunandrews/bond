#!/usr/bin/env node

/**
 * bond todo — CLI for managing Bond todos via the daemon.
 *
 * Usage:
 *   bond todo                                    List all todos
 *   bond todo add <text>                         Add a new todo
 *   bond todo add <text> --notes <n>             Add with notes
 *   bond todo add <text> --group <g>             Add with group
 *   bond todo add <text> --group <g> --notes <n> Add with both
 *   bond todo done <id|text>                     Mark as done
 *   bond todo undo <id|text>                     Mark as not done
 *   bond todo rm <id|text>                       Delete a todo
 *   bond todo notes <id|text> <notes>            Set notes
 *   bond todo group <id|text> <group>            Set group
 *   bond todo ls --group <g>                     List filtered by group
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const SOCK = join(homedir(), '.bond', 'bond.sock')

let reqId = 1

function call(ws: WebSocket, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = reqId++
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    const onMessage = (data: WebSocket.Data) => {
      const parsed = JSON.parse(data.toString())
      if (parsed.id === id) {
        ws.off('message', onMessage)
        if (parsed.error) reject(new Error(parsed.error.message))
        else resolve(parsed.result)
      }
    }

    ws.on('message', onMessage)
    ws.send(msg)
  })
}

interface Todo {
  id: string
  text: string
  notes: string
  group: string
  done: boolean
  createdAt: string
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${SOCK}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', (err) => reject(err))
  })
}

function findTodo(todos: Todo[], query: string): Todo | undefined {
  // Try exact ID prefix match first
  const byId = todos.find(t => t.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId
  // Try numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= todos.length) return todos[idx - 1]
  // Try case-insensitive text substring
  const lower = query.toLowerCase()
  return todos.find(t => t.text.toLowerCase().includes(lower))
}

const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const D = '\x1b[0;90m'
const S = '\x1b[9m'  // strikethrough
const N = '\x1b[0m'

function extractFlags(args: string[]): { textArgs: string[]; notes: string | undefined; group: string | undefined } {
  let notes: string | undefined
  let group: string | undefined
  const textArgs: string[] = []
  let i = 0
  while (i < args.length) {
    if (args[i] === '--notes') {
      // Collect everything up to the next flag or end
      i++
      const parts: string[] = []
      while (i < args.length && args[i] !== '--group') { parts.push(args[i]); i++ }
      notes = parts.join(' ')
    } else if (args[i] === '--group') {
      i++
      const parts: string[] = []
      while (i < args.length && args[i] !== '--notes') { parts.push(args[i]); i++ }
      group = parts.join(' ')
    } else {
      textArgs.push(args[i])
      i++
    }
  }
  return { textArgs, notes, group }
}

async function main() {
  const args = process.argv.slice(2)
  const sub = args[0] || 'list'

  let ws: WebSocket
  try {
    ws = await connect()
  } catch {
    console.error(`${R}Cannot connect to daemon${N} — is Bond running?`)
    process.exit(1)
  }

  try {
    switch (sub) {
      case 'list':
      case 'ls': {
        const { group: filterGroup } = extractFlags(args.slice(1))
        let todos = await call(ws, 'todo.list') as Todo[]
        if (filterGroup) todos = todos.filter(t => t.group === filterGroup)
        if (todos.length === 0) {
          console.log(`${D}No todos${filterGroup ? ` in group "${filterGroup}"` : ''}${N}`)
          break
        }
        const pending = todos.filter(t => !t.done)
        const done = todos.filter(t => t.done)
        pending.forEach((t, i) => {
          const groupTag = t.group ? ` ${D}[${t.group}]${N}` : ''
          console.log(`  ${D}${i + 1}.${N}  ${t.text}${groupTag}`)
          if (t.notes) {
            const lines = t.notes.split('\n')
            lines.forEach(line => console.log(`      ${D}${line}${N}`))
          }
        })
        if (done.length) {
          console.log(`\n  ${D}Done (${done.length})${N}`)
          done.forEach(t => {
            const groupTag = t.group ? ` ${D}[${t.group}]${N}` : ''
            console.log(`  ${D}${S}${t.text}${N}${groupTag}`)
          })
        }
        break
      }

      case 'add': {
        const { textArgs, notes, group } = extractFlags(args.slice(1))
        const text = textArgs.join(' ')
        if (!text) { console.error(`${R}Usage:${N} bond todo add <text> [--notes <notes>] [--group <group>]`); process.exit(1) }
        const todo = await call(ws, 'todo.create', { text, notes: notes ?? '', group: group ?? '' }) as Todo
        const groupTag = todo.group ? ` ${D}[${todo.group}]${N}` : ''
        console.log(`${G}Added${N}  ${todo.text}${groupTag}`)
        if (todo.notes) console.log(`      ${D}${todo.notes}${N}`)
        break
      }

      case 'notes': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond todo notes <id|number|text> <notes>`); process.exit(1) }
        const notesText = args.slice(2).join(' ')
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos, query)
        if (!todo) { console.error(`${R}No matching todo:${N} ${query}`); process.exit(1) }
        await call(ws, 'todo.update', { id: todo.id, updates: { notes: notesText } })
        console.log(`${G}Updated notes${N}  ${todo.text}`)
        if (notesText) console.log(`      ${D}${notesText}${N}`)
        break
      }

      case 'group':
      case 'tag': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond todo group <id|number|text> <group>`); process.exit(1) }
        const groupName = args.slice(2).join(' ')
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos, query)
        if (!todo) { console.error(`${R}No matching todo:${N} ${query}`); process.exit(1) }
        await call(ws, 'todo.update', { id: todo.id, updates: { group: groupName } })
        if (groupName) {
          console.log(`${G}Group set${N}  ${todo.text} ${D}[${groupName}]${N}`)
        } else {
          console.log(`${Y}Group removed${N}  ${todo.text}`)
        }
        break
      }

      case 'done':
      case 'check': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond todo done <id|number|text>`); process.exit(1) }
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos.filter(t => !t.done), query)
        if (!todo) { console.error(`${R}No matching todo:${N} ${query}`); process.exit(1) }
        await call(ws, 'todo.update', { id: todo.id, updates: { done: true } })
        console.log(`${G}Done${N}  ${D}${S}${todo.text}${N}`)
        break
      }

      case 'undo':
      case 'uncheck': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond todo undo <id|number|text>`); process.exit(1) }
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos.filter(t => t.done), query)
        if (!todo) { console.error(`${R}No matching done todo:${N} ${query}`); process.exit(1) }
        await call(ws, 'todo.update', { id: todo.id, updates: { done: false } })
        console.log(`${Y}Reopened${N}  ${todo.text}`)
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond todo rm <id|number|text>`); process.exit(1) }
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos, query)
        if (!todo) { console.error(`${R}No matching todo:${N} ${query}`); process.exit(1) }
        await call(ws, 'todo.delete', { id: todo.id })
        console.log(`${R}Deleted${N}  ${todo.text}`)
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond todo [list|add|done|undo|notes|group|rm] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
