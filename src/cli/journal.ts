#!/usr/bin/env node

/**
 * bond journal — CLI for managing Bond journal entries via the daemon.
 * Journal is now backed by the "Journal" collection.
 *
 * Usage:
 *   bond journal                                       List recent entries (last 20)
 *   bond journal ls                                    Same as above
 *   bond journal ls --author bond                      Filter by author
 *   bond journal ls --project <name>                   Filter by project
 *   bond journal ls --tag <tag>                        Filter by tag
 *   bond journal show <id|number|title>                Show full entry
 *   bond journal add "body text"                       Create entry (title + tags auto-generated)
 *   bond journal add --body "..."                      Create with explicit body flag
 *   echo "..." | bond journal add                      Create from stdin
 *   bond journal edit <id|number|title>                Edit entry (title/body/tags)
 *   bond journal rm <id|number|title>                  Delete an entry
 *   bond journal search <query>                        Full-text search
 *   bond journal pin <id|number|title>                 Pin/unpin toggle
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

// CollectionItem shape returned by the daemon
interface CollectionItem {
  id: string
  collectionId: string
  data: Record<string, unknown>
  projectId?: string
  sortOrder: number
  comments?: Array<{ id: string; itemId: string; author: string; body: string; createdAt: string }>
  createdAt: string
  updatedAt: string
}

// Helpers to extract journal fields from CollectionItem.data
function getTitle(item: CollectionItem): string {
  return (item.data.title as string) || 'Untitled'
}
function getBody(item: CollectionItem): string {
  return (item.data.body as string) || ''
}
function getAuthor(item: CollectionItem): string {
  return (item.data.author as string) || 'user'
}
function getTags(item: CollectionItem): string[] {
  return (item.data.tags as string[]) || []
}
function getPinned(item: CollectionItem): boolean {
  return (item.data.pinned as boolean) || false
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

function findEntry(entries: CollectionItem[], query: string): CollectionItem | undefined {
  // Try exact ID prefix match
  const byId = entries.find(e => e.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId
  // Try numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= entries.length) return entries[idx - 1]
  // Try case-insensitive title substring
  const lower = query.toLowerCase()
  return entries.find(e => getTitle(e).toLowerCase().includes(lower))
}

const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const C = '\x1b[0;36m'
const D = '\x1b[0;90m'
const B = '\x1b[1m'
const N = '\x1b[0m'

const FLAG_NAMES = new Set(['--body', '--author', '--project', '--tag', '--tags', '--session'])

function extractFlags(args: string[]): {
  textArgs: string[]
  body?: string
  author?: string
  project?: string
  tag?: string
  tags?: string
  session?: string
} {
  let body: string | undefined
  let author: string | undefined
  let project: string | undefined
  let tag: string | undefined
  let tags: string | undefined
  let session: string | undefined
  const textArgs: string[] = []
  let i = 0
  while (i < args.length) {
    if (args[i] === '--body') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      body = parts.join(' ')
    } else if (args[i] === '--author') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      author = parts.join(' ')
    } else if (args[i] === '--project') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      project = parts.join(' ')
    } else if (args[i] === '--tag') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      tag = parts.join(' ')
    } else if (args[i] === '--tags') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      tags = parts.join(' ')
    } else if (args[i] === '--session') {
      i++
      const parts: string[] = []
      while (i < args.length && !FLAG_NAMES.has(args[i])) { parts.push(args[i]); i++ }
      session = parts.join(' ')
    } else {
      textArgs.push(args[i])
      i++
    }
  }
  return { textArgs, body, author, project, tag, tags, session }
}

async function resolveProjectId(ws: WebSocket, query: string): Promise<string> {
  const projects = await call(ws, 'project.list') as Project[]
  const byId = projects.find(p => p.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId.id
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= projects.length) return projects[idx - 1].id
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

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return }
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
  })
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
        const { author, project, tag } = extractFlags(args.slice(1))
        let projectId: string | undefined
        if (project) projectId = await resolveProjectId(ws, project)
        const entries = await call(ws, 'journal.list', { author, projectId, tag, limit: 20 }) as CollectionItem[]
        if (entries.length === 0) {
          const filterDesc = author ? ` by ${author}` : project ? ` in project "${project}"` : tag ? ` tagged "${tag}"` : ''
          console.log(`${D}No journal entries${filterDesc}${N}`)
          break
        }
        // Build project name cache
        const projectIds = new Set(entries.map(e => e.projectId).filter(Boolean) as string[])
        const projectNames = new Map<string, string>()
        for (const pid of projectIds) {
          projectNames.set(pid, await getProjectName(ws, pid))
        }
        entries.forEach((e, i) => {
          const pin = getPinned(e) ? `${Y}*${N} ` : '  '
          const authorTag = getAuthor(e) === 'bond' ? `${C}bond${N}` : `${D}you${N}`
          const date = `${D}${formatDate(e.createdAt)}${N}`
          const tags = getTags(e)
          const tagsStr = tags.length > 0 ? ` ${D}[${tags.join(', ')}]${N}` : ''
          const projTag = e.projectId ? ` ${Y}← ${projectNames.get(e.projectId) ?? '?'}${N}` : ''
          console.log(`${pin}${D}${i + 1}.${N} ${B}${getTitle(e)}${N}  ${authorTag}  ${date}${tagsStr}${projTag}`)
          // Show first line of body as preview
          const firstLine = getBody(e).split('\n')[0]
          if (firstLine) {
            const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
            console.log(`     ${D}${preview}${N}`)
          }
        })
        break
      }

      case 'show':
      case 'view': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond journal show <id|number|title>`); process.exit(1) }
        const entries = await call(ws, 'journal.list', { limit: 100 }) as CollectionItem[]
        const entry = findEntry(entries, query)
        if (!entry) { console.error(`${R}No matching entry:${N} ${query}`); process.exit(1) }
        const authorTag = getAuthor(entry) === 'bond' ? `${C}bond${N}` : `${D}you${N}`
        const date = formatDate(entry.createdAt)
        const pin = getPinned(entry) ? ` ${Y}(pinned)${N}` : ''
        console.log(`\n${B}${getTitle(entry)}${N}${pin}`)
        console.log(`${authorTag}  ${D}${date}${N}`)
        const tags = getTags(entry)
        if (tags.length > 0) console.log(`${D}Tags: ${tags.join(', ')}${N}`)
        if (entry.projectId) {
          const projName = await getProjectName(ws, entry.projectId)
          console.log(`${Y}Project: ${projName}${N}`)
        }
        console.log()
        console.log(getBody(entry))
        console.log()
        break
      }

      case 'add':
      case 'new':
      case 'create': {
        const { textArgs, body, project, tags, session } = extractFlags(args.slice(1))
        // Body comes from --body flag, positional args, or stdin
        let entryBody = body ?? ''
        if (!entryBody && textArgs.length > 0) entryBody = textArgs.join(' ')
        if (!entryBody) entryBody = await readStdin()
        if (!entryBody) {
          console.error(`${R}Usage:${N} bond journal add "your entry text" [--project <p>]`)
          console.error(`       bond journal add --body "..." [--project <p>]`)
          console.error(`       echo "..." | bond journal add`)
          process.exit(1)
        }
        let projectId: string | undefined
        if (project) projectId = await resolveProjectId(ws, project)
        const parsedTags = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : undefined
        // Use first line as placeholder title
        const firstLine = entryBody.split('\n')[0].trim()
        const title = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine || 'Untitled'
        const entry = await call(ws, 'journal.create', {
          author: 'user', title, body: entryBody, tags: parsedTags, projectId, sessionId: session
        }) as CollectionItem
        // Auto-generate title + tags in the background
        console.log(`${G}Created${N}  ${D}generating title...${N}`)
        try {
          const updated = await call(ws, 'journal.generateMeta', { id: entry.id }) as CollectionItem | null
          if (updated) {
            const updatedTags = getTags(updated)
            const tagsStr = updatedTags.length > 0 ? ` ${D}[${updatedTags.join(', ')}]${N}` : ''
            console.log(`${G}  →${N}  ${B}${getTitle(updated)}${N}${tagsStr}`)
          }
        } catch {
          // Non-fatal — entry was still created with placeholder title
        }
        break
      }

      case 'edit': {
        const { textArgs, body, tags } = extractFlags(args.slice(1))
        const query = textArgs.join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond journal edit <id|number|title> [--body "..."] [--tags "a,b"]`); process.exit(1) }
        const entries = await call(ws, 'journal.list', { limit: 100 }) as CollectionItem[]
        const entry = findEntry(entries, query)
        if (!entry) { console.error(`${R}No matching entry:${N} ${query}`); process.exit(1) }
        const updates: Record<string, unknown> = {}
        if (body !== undefined) updates.body = body
        if (tags !== undefined) updates.tags = tags.split(',').map(t => t.trim()).filter(Boolean)
        // If the query looks like it might be a new title, and no other updates, treat textArgs[1..] as new title
        if (Object.keys(updates).length === 0) {
          console.error(`${R}Provide updates:${N} --body "..." or --tags "a,b"`)
          process.exit(1)
        }
        await call(ws, 'journal.update', { id: entry.id, updates })
        console.log(`${G}Updated${N}  ${B}${getTitle(entry)}${N}`)
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond journal rm <id|number|title>`); process.exit(1) }
        const entries = await call(ws, 'journal.list', { limit: 100 }) as CollectionItem[]
        const entry = findEntry(entries, query)
        if (!entry) { console.error(`${R}No matching entry:${N} ${query}`); process.exit(1) }
        await call(ws, 'journal.delete', { id: entry.id })
        console.log(`${R}Deleted${N}  ${getTitle(entry)}`)
        break
      }

      case 'search':
      case 'find': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond journal search <query>`); process.exit(1) }
        const entries = await call(ws, 'journal.search', { query }) as CollectionItem[]
        if (entries.length === 0) {
          console.log(`${D}No entries matching "${query}"${N}`)
          break
        }
        entries.forEach((e, i) => {
          const authorTag = getAuthor(e) === 'bond' ? `${C}bond${N}` : `${D}you${N}`
          const date = `${D}${formatDate(e.createdAt)}${N}`
          console.log(`  ${D}${i + 1}.${N} ${B}${getTitle(e)}${N}  ${authorTag}  ${date}`)
        })
        break
      }

      case 'pin': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond journal pin <id|number|title>`); process.exit(1) }
        const entries = await call(ws, 'journal.list', { limit: 100 }) as CollectionItem[]
        const entry = findEntry(entries, query)
        if (!entry) { console.error(`${R}No matching entry:${N} ${query}`); process.exit(1) }
        const newPinned = !getPinned(entry)
        await call(ws, 'journal.update', { id: entry.id, updates: { pinned: newPinned } })
        if (newPinned) {
          console.log(`${Y}Pinned${N}  ${getTitle(entry)}`)
        } else {
          console.log(`${D}Unpinned${N}  ${getTitle(entry)}`)
        }
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond journal [list|show|add|edit|rm|search|pin] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
