#!/usr/bin/env node

/**
 * bond project — CLI for managing Bond projects via the daemon.
 *
 * Usage:
 *   bond project                                         List all projects
 *   bond project add <name>                              Create a project
 *   bond project add <name> --goal <g>                   Create with goal
 *   bond project add <name> --type <t>                   Create with type (wordpress|web|presentation|generic)
 *   bond project add <name> --deadline <d>               Create with deadline (YYYY-MM-DD)
 *   bond project add <name> --goal <g> --type <t>        Create with all options
 *   bond project show <id|name>                          Show project details
 *   bond project edit <id|name> --name <n>               Update name
 *   bond project edit <id|name> --goal <g>               Update goal
 *   bond project edit <id|name> --type <t>               Update type
 *   bond project edit <id|name> --deadline <d>           Update deadline (empty to clear)
 *   bond project archive <id|name>                       Archive a project
 *   bond project unarchive <id|name>                     Unarchive a project
 *   bond project rm <id|name>                            Delete a project
 *   bond project resource add <id|name> <kind> <value> [label]  Add a resource (kind: path|file|link)
 *   bond project resource rm <id|name> <resourceId>             Remove a resource
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

interface Resource {
  id: string
  projectId: string
  kind: string
  value: string
  label?: string
  createdAt: string
}

interface Project {
  id: string
  name: string
  goal: string
  type: string
  archived: boolean
  deadline?: string
  resources: Resource[]
  createdAt: string
  updatedAt: string
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${SOCK}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', (err) => reject(err))
  })
}

function findProject(projects: Project[], query: string): Project | undefined {
  // Exact ID prefix
  const byId = projects.find(p => p.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId
  // Numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= projects.length) return projects[idx - 1]
  // Case-insensitive name substring
  const lower = query.toLowerCase()
  return projects.find(p => p.name.toLowerCase().includes(lower))
}

const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const B = '\x1b[0;34m'
const D = '\x1b[0;90m'
const N = '\x1b[0m'

const TYPE_LABELS: Record<string, string> = {
  wordpress: 'WordPress',
  web: 'Web',
  presentation: 'Presentation',
  generic: 'Generic',
}

function extractFlags(args: string[]): { textArgs: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {}
  const textArgs: string[] = []
  let i = 0
  while (i < args.length) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2)
      i++
      const parts: string[] = []
      while (i < args.length && !args[i].startsWith('--')) { parts.push(args[i]); i++ }
      flags[key] = parts.join(' ')
    } else {
      textArgs.push(args[i])
      i++
    }
  }
  return { textArgs, flags }
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
        const projects = await call(ws, 'project.list') as Project[]
        const active = projects.filter(p => !p.archived)
        const archived = projects.filter(p => p.archived)
        if (active.length === 0 && archived.length === 0) {
          console.log(`${D}No projects${N}`)
          break
        }
        active.forEach((p, i) => {
          const typeTag = ` ${D}[${TYPE_LABELS[p.type] ?? p.type}]${N}`
          const resCount = p.resources.length ? ` ${D}(${p.resources.length} resources)${N}` : ''
          const deadlineTag = p.deadline ? ` ${Y}due ${p.deadline}${N}` : ''
          console.log(`  ${D}${i + 1}.${N}  ${p.name}${typeTag}${deadlineTag}${resCount}`)
          if (p.goal) console.log(`      ${D}${p.goal}${N}`)
        })
        if (archived.length) {
          console.log(`\n  ${D}Archived (${archived.length})${N}`)
          archived.forEach(p => {
            console.log(`  ${D}${p.name} [${TYPE_LABELS[p.type] ?? p.type}]${N}`)
          })
        }
        break
      }

      case 'add':
      case 'create':
      case 'new': {
        const { textArgs, flags } = extractFlags(args.slice(1))
        const name = textArgs.join(' ')
        if (!name) { console.error(`${R}Usage:${N} bond project add <name> [--goal <goal>] [--type <type>]`); process.exit(1) }
        const project = await call(ws, 'project.create', {
          name,
          goal: flags.goal ?? '',
          type: flags.type ?? 'generic',
          deadline: flags.deadline
        }) as Project
        console.log(`${G}Created${N}  ${project.name} ${D}[${TYPE_LABELS[project.type] ?? project.type}]${N}`)
        if (project.goal) console.log(`      ${D}${project.goal}${N}`)
        console.log(`      ${D}id: ${project.id.slice(0, 8)}${N}`)
        break
      }

      case 'show':
      case 'info': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond project show <id|number|name>`); process.exit(1) }
        const projects = await call(ws, 'project.list') as Project[]
        const project = findProject(projects, query)
        if (!project) { console.error(`${R}No matching project:${N} ${query}`); process.exit(1) }

        console.log(`\n  ${B}${project.name}${N}  ${D}[${TYPE_LABELS[project.type] ?? project.type}]${N}`)
        if (project.goal) console.log(`  ${project.goal}`)
        console.log(`  ${D}id: ${project.id}${N}`)
        console.log(`  ${D}created: ${project.createdAt}${N}`)
        if (project.deadline) console.log(`  ${Y}deadline: ${project.deadline}${N}`)
        if (project.archived) console.log(`  ${Y}archived${N}`)

        if (project.resources.length) {
          console.log(`\n  ${D}Resources (${project.resources.length})${N}`)
          project.resources.forEach(r => {
            const label = r.label ? `${r.label} — ` : ''
            console.log(`    ${D}[${r.kind}]${N} ${label}${r.value}  ${D}(${r.id.slice(0, 8)})${N}`)
          })
        }
        console.log()
        break
      }

      case 'edit':
      case 'update': {
        const { textArgs, flags } = extractFlags(args.slice(1))
        const query = textArgs.join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond project edit <id|number|name> [--name <n>] [--goal <g>] [--type <t>] [--deadline <d>]`); process.exit(1) }
        const projects = await call(ws, 'project.list') as Project[]
        const project = findProject(projects, query)
        if (!project) { console.error(`${R}No matching project:${N} ${query}`); process.exit(1) }

        const updates: Record<string, unknown> = {}
        if (flags.name) updates.name = flags.name
        if (flags.goal !== undefined) updates.goal = flags.goal
        if (flags.type) updates.type = flags.type
        if (flags.deadline !== undefined) updates.deadline = flags.deadline || ''

        if (Object.keys(updates).length === 0) {
          console.error(`${R}Nothing to update.${N} Use --name, --goal, --type, or --deadline`)
          process.exit(1)
        }

        await call(ws, 'project.update', { id: project.id, updates })
        console.log(`${G}Updated${N}  ${project.name}`)
        break
      }

      case 'archive': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond project archive <id|number|name>`); process.exit(1) }
        const projects = await call(ws, 'project.list') as Project[]
        const project = findProject(projects.filter(p => !p.archived), query)
        if (!project) { console.error(`${R}No matching active project:${N} ${query}`); process.exit(1) }
        await call(ws, 'project.update', { id: project.id, updates: { archived: true } })
        console.log(`${Y}Archived${N}  ${project.name}`)
        break
      }

      case 'unarchive': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond project unarchive <id|number|name>`); process.exit(1) }
        const projects = await call(ws, 'project.list') as Project[]
        const project = findProject(projects.filter(p => p.archived), query)
        if (!project) { console.error(`${R}No matching archived project:${N} ${query}`); process.exit(1) }
        await call(ws, 'project.update', { id: project.id, updates: { archived: false } })
        console.log(`${G}Unarchived${N}  ${project.name}`)
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const query = args.slice(1).join(' ')
        if (!query) { console.error(`${R}Usage:${N} bond project rm <id|number|name>`); process.exit(1) }
        const projects = await call(ws, 'project.list') as Project[]
        const project = findProject(projects, query)
        if (!project) { console.error(`${R}No matching project:${N} ${query}`); process.exit(1) }
        await call(ws, 'project.delete', { id: project.id })
        console.log(`${R}Deleted${N}  ${project.name}`)
        break
      }

      case 'resource':
      case 'res': {
        const resSub = args[1]
        if (resSub === 'add') {
          // bond project resource add <project> <kind> <value> [label]
          // Also accepts --label <l> as a flag override
          const { textArgs, flags } = extractFlags(args.slice(2))
          if (textArgs.length < 3) {
            console.error(`${R}Usage:${N} bond project resource add <project> <kind> <value> [label]`)
            process.exit(1)
          }
          const projectQuery = textArgs[0]
          const kind = textArgs[1]
          const value = textArgs[2]
          // Label: --label flag takes precedence, then positional args after value
          const positionalLabel = textArgs.length > 3 ? textArgs.slice(3).join(' ') : undefined

          if (!['path', 'file', 'link'].includes(kind)) {
            console.error(`${R}Invalid kind:${N} ${kind} (use path, file, or link)`)
            process.exit(1)
          }

          const projects = await call(ws, 'project.list') as Project[]
          const project = findProject(projects, projectQuery)
          if (!project) { console.error(`${R}No matching project:${N} ${projectQuery}`); process.exit(1) }

          const label = flags.label || positionalLabel
          const resource = await call(ws, 'project.addResource', {
            projectId: project.id,
            kind,
            value,
            label
          }) as Resource
          const labelDisplay = label ? `${label} — ` : ''
          console.log(`${G}Added${N}  [${kind}] ${labelDisplay}${value} to ${project.name}  ${D}(${resource.id.slice(0, 8)})${N}`)
        } else if (resSub === 'rm' || resSub === 'remove') {
          // bond project resource rm <project> <resourceId>
          const projectQuery = args[2]
          const resourceQuery = args[3]
          if (!projectQuery || !resourceQuery) {
            console.error(`${R}Usage:${N} bond project resource rm <project> <resourceId>`)
            process.exit(1)
          }
          const projects = await call(ws, 'project.list') as Project[]
          const project = findProject(projects, projectQuery)
          if (!project) { console.error(`${R}No matching project:${N} ${projectQuery}`); process.exit(1) }

          const resource = project.resources.find(r => r.id.toLowerCase().startsWith(resourceQuery.toLowerCase()))
          if (!resource) { console.error(`${R}No matching resource:${N} ${resourceQuery}`); process.exit(1) }

          await call(ws, 'project.removeResource', { id: resource.id })
          console.log(`${R}Removed${N}  [${resource.kind}] ${resource.value} from ${project.name}`)
        } else {
          console.error(`${R}Usage:${N} bond project resource [add|rm] ...`)
          process.exit(1)
        }
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond project [list|add|show|edit|archive|unarchive|rm|resource] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
