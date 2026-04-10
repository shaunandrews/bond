#!/usr/bin/env node

/**
 * bond collection — CLI for managing Bond collections via the daemon.
 *
 * Usage:
 *   bond collection                                        List all collections
 *   bond collection create <name> --icon 🎬 --schema '<json>'   Create a collection
 *   bond collection show <name|id>                         Show collection details
 *   bond collection schema <name|id>                       Print schema as JSON
 *   bond collection edit <name|id> --name <n>              Rename
 *   bond collection edit <name|id> --icon <i>              Change icon
 *   bond collection archive <name|id>                      Archive
 *   bond collection unarchive <name|id>                    Unarchive
 *   bond collection rm <name|id>                           Delete
 *
 *   bond collection ls <name|id>                           List items
 *   bond collection ls <name|id> --<field> <value>         Filter items
 *   bond collection add <name|id> --<field> <value>        Add an item
 *   bond collection update <name|id> <item> --<field> <v>  Update item fields
 *   bond collection done <name|id> <item>                  Mark status-like field done
 *   bond collection info <name|id> <item>                  Show full item details
 *   bond collection rm <name|id> <item>                    Delete an item
 */

import { call, connect, WebSocket } from './connect'

interface Collection {
  id: string
  name: string
  icon: string
  schema: FieldDef[]
  archived: boolean
  createdAt: string
  updatedAt: string
}

interface FieldDef {
  name: string
  type: string
  primary?: boolean
  options?: string[]
  max?: number
  prefix?: string
  suffix?: string
}

interface CollectionItem {
  id: string
  collectionId: string
  data: Record<string, unknown>
  sortOrder: number
  createdAt: string
  updatedAt: string
}

const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const B = '\x1b[0;34m'
const D = '\x1b[0;90m'
const N = '\x1b[0m'

function findCollection(collections: Collection[], query: string): Collection | undefined {
  // ID prefix
  const byId = collections.find(c => c.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId
  // Numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= collections.length) return collections[idx - 1]
  // Name substring (case-insensitive)
  const lower = query.toLowerCase()
  return collections.find(c => c.name.toLowerCase().includes(lower))
}

function getPrimaryField(schema: FieldDef[]): FieldDef | undefined {
  return schema.find(f => f.primary)
}

function getItemLabel(item: CollectionItem, schema: FieldDef[]): string {
  const primary = getPrimaryField(schema)
  if (primary) {
    const val = item.data[primary.name]
    if (val != null) return String(val)
  }
  // Fallback: first text value
  for (const f of schema) {
    const val = item.data[f.name]
    if (val != null && typeof val === 'string' && val.length > 0) return val
  }
  return item.id.slice(0, 8)
}

function findItem(items: CollectionItem[], query: string, schema: FieldDef[]): CollectionItem | undefined {
  // ID prefix
  const byId = items.find(i => i.id.toLowerCase().startsWith(query.toLowerCase()))
  if (byId) return byId
  // Numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= items.length) return items[idx - 1]
  // Primary field substring
  const lower = query.toLowerCase()
  const primary = getPrimaryField(schema)
  if (primary) {
    return items.find(i => {
      const val = i.data[primary.name]
      return val != null && String(val).toLowerCase().includes(lower)
    })
  }
  return undefined
}

function formatFieldValue(value: unknown, field: FieldDef): string {
  if (value == null) return `${D}—${N}`
  switch (field.type) {
    case 'boolean': return value ? `${G}yes${N}` : `${D}no${N}`
    case 'rating': {
      const max = field.max ?? 5
      const n = typeof value === 'number' ? value : 0
      return '★'.repeat(n) + `${D}${'☆'.repeat(max - n)}${N}`
    }
    case 'select': return `${Y}${value}${N}`
    case 'multiselect':
    case 'tags':
      return Array.isArray(value) ? value.map(v => `${Y}${v}${N}`).join(', ') : String(value)
    case 'number': {
      const prefix = field.prefix ?? ''
      const suffix = field.suffix ?? ''
      return `${prefix}${value}${suffix}`
    }
    default: return String(value)
  }
}

function parseFieldValue(raw: string, field: FieldDef): unknown {
  switch (field.type) {
    case 'number':
    case 'rating':
      return Number(raw)
    case 'boolean':
      return raw === 'true' || raw === 'yes' || raw === '1'
    case 'multiselect':
    case 'tags':
      return raw.split(',').map(s => s.trim())
    default:
      return raw
  }
}

/** Extract dynamic --field value flags based on a collection's schema */
function extractSchemaFlags(args: string[], schema: FieldDef[]): { restArgs: string[]; data: Record<string, unknown> } {
  const fieldNames = new Set(schema.map(f => `--${f.name}`))
  const data: Record<string, unknown> = {}
  const restArgs: string[] = []
  let i = 0
  while (i < args.length) {
    if (args[i].startsWith('--') && fieldNames.has(args[i])) {
      const fieldName = args[i].slice(2)
      const field = schema.find(f => f.name === fieldName)!
      i++
      const parts: string[] = []
      while (i < args.length && !args[i].startsWith('--')) { parts.push(args[i]); i++ }
      data[fieldName] = parseFieldValue(parts.join(' '), field)
    } else {
      restArgs.push(args[i])
      i++
    }
  }
  return { restArgs, data }
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
      case 'list': {
        const collections = await call(ws, 'collection.list') as Collection[]
        const active = collections.filter(c => !c.archived)
        const archived = collections.filter(c => c.archived)
        if (active.length === 0 && archived.length === 0) {
          console.log(`${D}No collections${N}`)
          break
        }
        active.forEach((c, i) => {
          const icon = c.icon ? `${c.icon} ` : ''
          const fieldCount = c.schema.length
          console.log(`  ${D}${i + 1}.${N}  ${icon}${c.name}  ${D}(${fieldCount} fields)${N}`)
        })
        if (archived.length) {
          console.log(`\n  ${D}Archived (${archived.length})${N}`)
          archived.forEach(c => {
            const icon = c.icon ? `${c.icon} ` : ''
            console.log(`  ${D}${icon}${c.name}${N}`)
          })
        }
        break
      }

      case 'create': {
        const name = args[1]
        if (!name) { console.error(`${R}Usage:${N} bond collection create <name> --icon <emoji> --schema '<json>'`); process.exit(1) }
        let icon = ''
        let schemaJson = '[]'
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--icon' && args[i + 1]) { icon = args[++i] }
          else if (args[i] === '--schema' && args[i + 1]) { schemaJson = args[++i] }
        }
        let schema: FieldDef[]
        try { schema = JSON.parse(schemaJson) } catch { console.error(`${R}Invalid schema JSON${N}`); process.exit(1); return }
        const created = await call(ws, 'collection.create', { name, schema, icon }) as Collection
        const iconStr = created.icon ? `${created.icon} ` : ''
        console.log(`${G}Created${N}  ${iconStr}${created.name}  ${D}(${schema.length} fields)${N}`)
        break
      }

      case 'show': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection show <name|id>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, query)
        if (!col) { console.error(`${R}No matching collection:${N} ${query}`); process.exit(1) }
        const items = await call(ws, 'collection.listItems', { collectionId: col.id }) as CollectionItem[]
        const icon = col.icon ? `${col.icon} ` : ''
        console.log(`\n  ${icon}${B}${col.name}${N}  ${D}(${items.length} items)${N}`)
        console.log(`  ${D}ID: ${col.id.slice(0, 8)}...${N}`)
        console.log(`\n  ${D}Schema:${N}`)
        for (const f of col.schema) {
          const primary = f.primary ? ` ${Y}(primary)${N}` : ''
          const opts = f.options ? ` ${D}[${f.options.join(', ')}]${N}` : ''
          const extra = f.max ? ` ${D}max:${f.max}${N}` : ''
          console.log(`    ${f.name}: ${D}${f.type}${N}${primary}${opts}${extra}`)
        }
        break
      }

      case 'schema': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection schema <name|id>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, query)
        if (!col) { console.error(`${R}No matching collection:${N} ${query}`); process.exit(1) }
        console.log(JSON.stringify(col.schema, null, 2))
        break
      }

      case 'edit': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection edit <name|id> --name <n> --icon <i>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, query)
        if (!col) { console.error(`${R}No matching collection:${N} ${query}`); process.exit(1) }
        const updates: Record<string, unknown> = {}
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--name' && args[i + 1]) updates.name = args[++i]
          else if (args[i] === '--icon' && args[i + 1]) updates.icon = args[++i]
        }
        if (Object.keys(updates).length === 0) { console.error(`${R}No updates specified${N}`); process.exit(1) }
        await call(ws, 'collection.update', { id: col.id, updates })
        console.log(`${G}Updated${N}  ${col.name}`)
        break
      }

      case 'archive': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection archive <name|id>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections.filter(c => !c.archived), query)
        if (!col) { console.error(`${R}No matching collection:${N} ${query}`); process.exit(1) }
        await call(ws, 'collection.update', { id: col.id, updates: { archived: true } })
        console.log(`${Y}Archived${N}  ${col.name}`)
        break
      }

      case 'unarchive': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection unarchive <name|id>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections.filter(c => c.archived), query)
        if (!col) { console.error(`${R}No matching archived collection:${N} ${query}`); process.exit(1) }
        await call(ws, 'collection.update', { id: col.id, updates: { archived: false } })
        console.log(`${G}Unarchived${N}  ${col.name}`)
        break
      }

      case 'ls': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection ls <name|id> [--field value]`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, query)
        if (!col) { console.error(`${R}No matching collection:${N} ${query}`); process.exit(1) }
        const { data: filters } = extractSchemaFlags(args.slice(2), col.schema)
        let items = await call(ws, 'collection.listItems', { collectionId: col.id }) as CollectionItem[]

        // Apply filters
        for (const [key, val] of Object.entries(filters)) {
          items = items.filter(item => {
            const itemVal = item.data[key]
            if (itemVal == null) return false
            return String(itemVal).toLowerCase() === String(val).toLowerCase()
          })
        }

        const icon = col.icon ? `${col.icon} ` : ''
        if (items.length === 0) {
          console.log(`${D}No items in ${icon}${col.name}${N}`)
          break
        }
        console.log(`\n  ${icon}${B}${col.name}${N}  ${D}(${items.length} items)${N}\n`)
        items.forEach((item, i) => {
          const label = getItemLabel(item, col.schema)
          console.log(`  ${D}${i + 1}.${N}  ${label}`)
          for (const f of col.schema) {
            if (f.primary) continue
            const val = item.data[f.name]
            if (val == null) continue
            console.log(`      ${D}${f.name}:${N} ${formatFieldValue(val, f)}`)
          }
        })
        break
      }

      case 'add': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond collection add <name|id> --field value`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, query)
        if (!col) { console.error(`${R}No matching collection:${N} ${query}`); process.exit(1) }
        const { data } = extractSchemaFlags(args.slice(2), col.schema)
        if (Object.keys(data).length === 0) {
          console.error(`${R}No fields specified.${N} Available: ${col.schema.map(f => `--${f.name}`).join(' ')}`)
          process.exit(1)
        }
        const item = await call(ws, 'collection.addItem', { collectionId: col.id, data }) as CollectionItem
        const label = getItemLabel(item, col.schema)
        console.log(`${G}Added${N}  ${label}`)
        break
      }

      case 'update': {
        const colQuery = args[1]
        const itemQuery = args[2]
        if (!colQuery || !itemQuery) { console.error(`${R}Usage:${N} bond collection update <collection> <item> --field value`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, colQuery)
        if (!col) { console.error(`${R}No matching collection:${N} ${colQuery}`); process.exit(1) }
        const items = await call(ws, 'collection.listItems', { collectionId: col.id }) as CollectionItem[]
        const item = findItem(items, itemQuery, col.schema)
        if (!item) { console.error(`${R}No matching item:${N} ${itemQuery}`); process.exit(1) }
        const { data } = extractSchemaFlags(args.slice(3), col.schema)
        if (Object.keys(data).length === 0) { console.error(`${R}No updates specified${N}`); process.exit(1) }
        await call(ws, 'collection.updateItem', { id: item.id, data })
        const label = getItemLabel(item, col.schema)
        console.log(`${G}Updated${N}  ${label}`)
        break
      }

      case 'done': {
        const colQuery = args[1]
        const itemQuery = args.slice(2).join(' ')
        if (!colQuery || !itemQuery) { console.error(`${R}Usage:${N} bond collection done <collection> <item>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, colQuery)
        if (!col) { console.error(`${R}No matching collection:${N} ${colQuery}`); process.exit(1) }
        // Find a status-like select field
        const statusField = col.schema.find(f =>
          f.type === 'select' && f.name.toLowerCase().includes('status')
        ) || col.schema.find(f => f.type === 'boolean' && f.name.toLowerCase().includes('done'))
        if (!statusField) { console.error(`${R}No status field found in schema${N}`); process.exit(1) }
        const items = await call(ws, 'collection.listItems', { collectionId: col.id }) as CollectionItem[]
        const item = findItem(items, itemQuery, col.schema)
        if (!item) { console.error(`${R}No matching item:${N} ${itemQuery}`); process.exit(1) }
        let doneValue: unknown
        if (statusField.type === 'boolean') {
          doneValue = true
        } else {
          // Pick the last option (usually "Watched", "Finished", "Done")
          const opts = statusField.options ?? []
          doneValue = opts.find(o => /finish|done|watch|complete|caught up/i.test(o)) ?? opts[opts.length - 1] ?? 'Done'
        }
        await call(ws, 'collection.updateItem', { id: item.id, data: { [statusField.name]: doneValue } })
        const label = getItemLabel(item, col.schema)
        console.log(`${G}Done${N}  ${label}  ${D}${statusField.name}: ${doneValue}${N}`)
        break
      }

      case 'info': {
        const colQuery = args[1]
        const itemQuery = args.slice(2).join(' ')
        if (!colQuery || !itemQuery) { console.error(`${R}Usage:${N} bond collection info <collection> <item>`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, colQuery)
        if (!col) { console.error(`${R}No matching collection:${N} ${colQuery}`); process.exit(1) }
        const items = await call(ws, 'collection.listItems', { collectionId: col.id }) as CollectionItem[]
        const item = findItem(items, itemQuery, col.schema)
        if (!item) { console.error(`${R}No matching item:${N} ${itemQuery}`); process.exit(1) }
        const label = getItemLabel(item, col.schema)
        console.log(`\n  ${B}${label}${N}`)
        console.log(`  ${D}ID: ${item.id.slice(0, 8)}...${N}`)
        for (const f of col.schema) {
          if (f.primary) continue
          const val = item.data[f.name]
          console.log(`  ${f.name}: ${formatFieldValue(val, f)}`)
        }
        console.log()
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const colQuery = args[1]
        if (!colQuery) { console.error(`${R}Usage:${N} bond collection rm <collection> [item]`); process.exit(1) }
        const collections = await call(ws, 'collection.list') as Collection[]
        const col = findCollection(collections, colQuery)
        if (!col) { console.error(`${R}No matching collection:${N} ${colQuery}`); process.exit(1) }

        const itemQuery = args.slice(2).join(' ')
        if (itemQuery) {
          // Delete an item
          const items = await call(ws, 'collection.listItems', { collectionId: col.id }) as CollectionItem[]
          const item = findItem(items, itemQuery, col.schema)
          if (!item) { console.error(`${R}No matching item:${N} ${itemQuery}`); process.exit(1) }
          await call(ws, 'collection.deleteItem', { id: item.id })
          const label = getItemLabel(item, col.schema)
          console.log(`${R}Deleted${N}  ${label}`)
        } else {
          // Delete the collection
          await call(ws, 'collection.delete', { id: col.id })
          console.log(`${R}Deleted${N}  ${col.name}`)
        }
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond collection [list|create|show|schema|edit|archive|unarchive|ls|add|update|done|info|rm] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
