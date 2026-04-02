#!/usr/bin/env node

/**
 * bond todo — CLI for managing Bond todos via the daemon.
 *
 * Usage:
 *   bond todo                  List all todos
 *   bond todo add <text>       Add a new todo
 *   bond todo done <id|text>   Mark a todo as done
 *   bond todo undo <id|text>   Mark a todo as not done
 *   bond todo rm <id|text>     Delete a todo
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
        const todos = await call(ws, 'todo.list') as Todo[]
        if (todos.length === 0) {
          console.log(`${D}No todos${N}`)
          break
        }
        const pending = todos.filter(t => !t.done)
        const done = todos.filter(t => t.done)
        pending.forEach((t, i) => {
          console.log(`  ${D}${i + 1}.${N}  ${t.text}`)
        })
        if (done.length) {
          console.log(`\n  ${D}Done (${done.length})${N}`)
          done.forEach(t => {
            console.log(`  ${D}${S}${t.text}${N}`)
          })
        }
        break
      }

      case 'add': {
        const text = args.slice(1).join(' ')
        if (!text) { console.error(`${R}Usage:${N} bond todo add <text>`); process.exit(1) }
        const todo = await call(ws, 'todo.create', { text }) as Todo
        console.log(`${G}Added${N}  ${todo.text}`)
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
        console.log(`\nUsage: bond todo [list|add|done|undo|rm] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
