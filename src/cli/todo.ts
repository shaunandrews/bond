#!/usr/bin/env node

/**
 * bond todo — CLI for managing Bond todos via the daemon.
 *
 * Usage:
 *   bond todo                                           List all todos
 *   bond todo add <text>                                Add a new todo
 *   bond todo add <text> --notes <n>                    Add with notes
 *   bond todo add <text> --group <g>                    Add with group
 *   bond todo add <text> --project <p>                  Add linked to a project
 *   bond todo done <id|text>                            Mark as done
 *   bond todo undo <id|text>                            Mark as not done
 *   bond todo rm <id|text>                              Delete a todo
 *   bond todo notes <id|text> <notes>                   Set notes
 *   bond todo group <id|text> <group>                   Set group
 *   bond todo link <id|text> <project>                  Link a todo to a project
 *   bond todo unlink <id|text>                          Remove project link
 *   bond todo move <id|text> <position>                 Move a todo to a position (1-based)
 *   bond todo ls --group <g>                            List filtered by group
 *   bond todo ls --project <p>                          List filtered by project
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
  projectId?: string
  createdAt: string
}

interface Project {
  id: string
  name: string
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

const FLAG_NAMES = new Set(['--notes', '--group', '--project'])

function extractFlags(args: string[]): { textArgs: string[]; notes: string | undefined; group: string | undefined; project: string | undefined } {
  let notes: string | undefined
  let group: string | undefined
  let project: string | undefined
  const textArgs: string[] = []
  let i = 0
  while (i < args.length) {
    if (args[i] === '--notes') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      notes = parts.join(' ')
    } else if (args[i] === '--group') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      group = parts.join(' ')
    } else if (args[i] === '--project') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      project = parts.join(' ')
    } else {
      textArgs.push(args[i])
      i++
    }
  }
  return { textArgs, notes, group, project }
}

async function resolveProjectId(ws: WebSocket, query: string): Promise<string> {
  const projects = await call(ws, 'project.list') as Project[]
  // ID prefix
  const byId = projects.find(p => p.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId.id
  // Numeric index
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= projects.length) return projects[idx - 1].id
  // Name substring
  const lower = query.toLowerCase()
  const byName = projects.find(p => p.name.toLowerCase().includes(lower))
  if (byName) return byName.id
  console.error(`${R}No matching project:${N} ${query}`)
  process.exit(1)
}

async function getProjectName(ws: WebSocket, projectId: string): Promise<string> {
  const project = await call(ws, 'project.get', { id: projectId }) as Project | null
  return project?.name ?? projectId.slice(0, 8)
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
        const { group: filterGroup, project: filterProject } = extractFlags(args.slice(1))
        let todos = await call(ws, 'todo.list') as Todo[]
        if (filterGroup) todos = todos.filter(t => t.group === filterGroup)
        let filterProjectId: string | undefined
        if (filterProject) {
          filterProjectId = await resolveProjectId(ws, filterProject)
          todos = todos.filter(t => t.projectId === filterProjectId)
        }
        const filterDesc = filterGroup ? ` in group "${filterGroup}"` : filterProject ? ` in project "${filterProject}"` : ''
        if (todos.length === 0) {
          console.log(`${D}No todos${filterDesc}${N}`)
          break
        }
        // Build project name cache for display
        const projectIds = new Set(todos.map(t => t.projectId).filter(Boolean) as string[])
        const projectNames = new Map<string, string>()
        for (const pid of projectIds) {
          projectNames.set(pid, await getProjectName(ws, pid))
        }
        const pending = todos.filter(t => !t.done)
        const done = todos.filter(t => t.done)
        pending.forEach((t, i) => {
          const groupTag = t.group ? ` ${D}[${t.group}]${N}` : ''
          const projTag = t.projectId ? ` ${Y}← ${projectNames.get(t.projectId) ?? '?'}${N}` : ''
          console.log(`  ${D}${i + 1}.${N}  ${t.text}${groupTag}${projTag}`)
          if (t.notes) {
            const lines = t.notes.split('\n')
            lines.forEach(line => console.log(`      ${D}${line}${N}`))
          }
        })
        if (done.length) {
          console.log(`\n  ${D}Done (${done.length})${N}`)
          done.forEach(t => {
            const groupTag = t.group ? ` ${D}[${t.group}]${N}` : ''
            const projTag = t.projectId ? ` ${Y}← ${projectNames.get(t.projectId) ?? '?'}${N}` : ''
            console.log(`  ${D}${S}${t.text}${N}${groupTag}${projTag}`)
          })
        }
        break
      }

      case 'add': {
        const { textArgs, notes, group, project } = extractFlags(args.slice(1))
        const text = textArgs.join(' ')
        if (!text) { console.error(`${R}Usage:${N} bond todo add <text> [--notes <notes>] [--group <group>] [--project <project>]`); process.exit(1) }
        let projectId: string | undefined
        if (project) projectId = await resolveProjectId(ws, project)
        const todo = await call(ws, 'todo.create', { text, notes: notes ?? '', group: group ?? '', projectId }) as Todo
        const groupTag = todo.group ? ` ${D}[${todo.group}]${N}` : ''
        const projTag = project ? ` ${Y}← ${project}${N}` : ''
        console.log(`${G}Added${N}  ${todo.text}${groupTag}${projTag}`)
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

      case 'link': {
        const todoQuery = args[1]
        const projectQuery = args.slice(2).join(' ')
        if (!todoQuery || !projectQuery) { console.error(`${R}Usage:${N} bond todo link <id|number|text> <project>`); process.exit(1) }
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos, todoQuery)
        if (!todo) { console.error(`${R}No matching todo:${N} ${todoQuery}`); process.exit(1) }
        const projectId = await resolveProjectId(ws, projectQuery)
        const projectName = await getProjectName(ws, projectId)
        await call(ws, 'todo.update', { id: todo.id, updates: { projectId } })
        console.log(`${G}Linked${N}  ${todo.text} ${Y}← ${projectName}${N}`)
        break
      }

      case 'unlink': {
        const todoQuery = args.slice(1).join(' ')
        if (!todoQuery) { console.error(`${R}Usage:${N} bond todo unlink <id|number|text>`); process.exit(1) }
        const todos = await call(ws, 'todo.list') as Todo[]
        const todo = findTodo(todos, todoQuery)
        if (!todo) { console.error(`${R}No matching todo:${N} ${todoQuery}`); process.exit(1) }
        if (!todo.projectId) { console.log(`${D}Todo is not linked to a project${N}`); break }
        await call(ws, 'todo.update', { id: todo.id, updates: { projectId: '' } })
        console.log(`${Y}Unlinked${N}  ${todo.text}`)
        break
      }

      case 'move':
      case 'mv': {
        const todoQuery = args[1]
        const posStr = args[2]
        if (!todoQuery || !posStr) { console.error(`${R}Usage:${N} bond todo move <id|number|text> <position>`); process.exit(1) }
        const pos = parseInt(posStr, 10)
        if (isNaN(pos) || pos < 1) { console.error(`${R}Position must be a positive number${N}`); process.exit(1) }
        const todos = await call(ws, 'todo.list') as Todo[]
        const pending = todos.filter(t => !t.done)
        const done = todos.filter(t => t.done)
        const todo = findTodo(todos, todoQuery)
        if (!todo) { console.error(`${R}No matching todo:${N} ${todoQuery}`); process.exit(1) }
        const ids = pending.map(t => t.id)
        const fromIdx = ids.indexOf(todo.id)
        if (fromIdx === -1) { console.error(`${R}Cannot reorder a completed todo${N}`); process.exit(1) }
        ids.splice(fromIdx, 1)
        const toIdx = Math.min(pos - 1, ids.length)
        ids.splice(toIdx, 0, todo.id)
        await call(ws, 'todo.reorder', { ids: [...ids, ...done.map(t => t.id)] })
        console.log(`${G}Moved${N}  ${todo.text} ${D}→ position ${toIdx + 1}${N}`)
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond todo [list|add|done|undo|notes|group|link|unlink|move|rm] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
