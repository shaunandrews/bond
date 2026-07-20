#!/usr/bin/env node

/**
 * bond library — CLI for managing Bond's Library (documents + media) via the daemon.
 *
 * Usage:
 *   bond library                        List all assets
 *   bond library list [--documents|--media]
 *   bond library add <path|url|-> [--title <t>]   Import a document
 *   bond library import <path|url|->    Alias of add
 *   bond library info <id|number>       Show details for an asset
 *   bond library open <id|number>       Open (markdown/plaintext in-app, else native)
 *   bond library reveal <id|number>     Reveal in Finder
 *   bond library rm <id|number>         Delete an asset
 *   bond library ref add <assetId|number> <itemId>   Attach a reference
 *   bond library ref rm <assetId|number> <itemId>    Remove a reference
 *   bond library ref list <itemId>      List assets referenced by an item
 *   bond library backlinks <assetId|number>          List items referencing an asset
 */

import { extname, join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { call, connect, WebSocket } from './connect'
import { findAsset, formatSize, formatDate, detectDocFormat, detectDocFormatFromResponse } from './library-helpers'

interface LibraryAsset {
  id: string
  kind: 'document' | 'media'
  format: string
  title: string
  filename: string
  mediaType: string
  sizeBytes: number
  managedPath: string
  sourceUrl?: string
  createdAt: string
  updatedAt: string
}

const R = '\x1b[0;31m'
const G = '\x1b[0;32m'
const Y = '\x1b[0;33m'
const B = '\x1b[0;34m'
const D = '\x1b[0;90m'
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
        const kindFlag = args.includes('--documents') ? 'document' : args.includes('--media') ? 'media' : undefined
        const assets = await call(ws, 'library.list', kindFlag ? { kind: kindFlag } : undefined) as LibraryAsset[]
        if (assets.length === 0) {
          console.log(`${D}No assets${N}`)
          break
        }
        const totalBytes = assets.reduce((sum, a) => sum + a.sizeBytes, 0)
        console.log(`  ${D}${assets.length} asset${assets.length === 1 ? '' : 's'} · ${formatSize(totalBytes)}${N}\n`)
        assets.forEach((a, i) => {
          const date = formatDate(a.createdAt)
          const size = formatSize(a.sizeBytes)
          const kind = a.kind === 'document' ? Y : G
          console.log(`  ${D}${i + 1}.${N}  ${kind}${a.kind.padEnd(8)}${N} ${size.padEnd(10)} ${date.padEnd(24)} ${D}${a.title}${N}`)
        })
        break
      }

      case 'info': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond library info <id|number>`); process.exit(1) }
        const assets = await call(ws, 'library.list') as LibraryAsset[]
        const asset = findAsset(assets, query)
        if (!asset) { console.error(`${R}No matching asset:${N} ${query}`); process.exit(1) }
        console.log(`  ${B}ID${N}         ${asset.id}`)
        console.log(`  ${B}Title${N}      ${asset.title}`)
        console.log(`  ${B}Kind${N}       ${asset.kind}`)
        console.log(`  ${B}Format${N}     ${asset.format}`)
        console.log(`  ${B}Type${N}       ${asset.mediaType}`)
        console.log(`  ${B}Size${N}       ${formatSize(asset.sizeBytes)}`)
        console.log(`  ${B}Created${N}    ${formatDate(asset.createdAt)}`)
        console.log(`  ${B}Path${N}       ${asset.managedPath}`)
        if (asset.sourceUrl) console.log(`  ${B}Source${N}     ${asset.sourceUrl}`)
        break
      }

      case 'open': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond library open <id|number>`); process.exit(1) }
        const assets = await call(ws, 'library.list') as LibraryAsset[]
        const asset = findAsset(assets, query)
        if (!asset) { console.error(`${R}No matching asset:${N} ${query}`); process.exit(1) }
        execSync(`open "${asset.managedPath}"`)
        console.log(`${G}Opened${N}  ${asset.title}`)
        break
      }

      case 'reveal': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond library reveal <id|number>`); process.exit(1) }
        const assets = await call(ws, 'library.list') as LibraryAsset[]
        const asset = findAsset(assets, query)
        if (!asset) { console.error(`${R}No matching asset:${N} ${query}`); process.exit(1) }
        execSync(`open -R "${asset.managedPath}"`)
        console.log(`${G}Revealed${N}  ${asset.title}`)
        break
      }

      case 'add':
      case 'import': {
        const positional = args.slice(1).filter(a => a !== '--title')
        const titleIdx = args.indexOf('--title')
        const title = titleIdx !== -1 ? args[titleIdx + 1] : undefined
        const source = positional[0]
        if (!source) {
          console.error(`${R}Usage:${N} bond library add <path|url|-> [--title <t>]`)
          process.exit(1)
        }

        let buf: Buffer
        let format: string | undefined
        let mediaType: string | undefined
        let filename: string

        if (source === '-') {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
          buf = Buffer.concat(chunks)
          format = 'other'
          mediaType = 'application/octet-stream'
          filename = title ? `${title}.txt` : 'stdin.txt'
        } else if (/^https?:\/\//i.test(source)) {
          let response: Response
          try {
            response = await fetch(source, { headers: { 'User-Agent': 'Bond/1.0' }, redirect: 'follow' })
          } catch (err) {
            console.error(`${R}Failed to fetch:${N} ${err instanceof Error ? err.message : err}`)
            process.exit(1)
          }
          if (!response.ok) {
            console.error(`${R}HTTP ${response.status}${N} ${response.statusText}`)
            process.exit(1)
          }
          const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
          const urlExt = '.' + (source.split('?')[0].split('.').pop()?.toLowerCase() ?? '')
          ;({ format, mediaType } = detectDocFormatFromResponse(contentType, urlExt))
          filename = source.split('?')[0].split('/').pop() || 'download'
          buf = Buffer.from(await response.arrayBuffer())
        } else {
          const filePath = source.startsWith('~') ? join(homedir(), source.slice(1)) : source
          if (!existsSync(filePath)) { console.error(`${R}File not found:${N} ${filePath}`); process.exit(1) }
          const stat = statSync(filePath)
          if (!stat.isFile()) { console.error(`${R}Not a file:${N} ${filePath}`); process.exit(1) }
          const ext = extname(filePath).toLowerCase()
          ;({ format, mediaType } = detectDocFormat(ext))
          filename = filePath.split('/').pop()!
          buf = readFileSync(filePath)
        }

        const data = buf.toString('base64')
        const asset = await call(ws, 'library.addDocument', { title, filename, mediaType, format, data }) as LibraryAsset
        console.log(`${G}Added${N}  ${formatSize(buf.length)}  ${D}${asset.id}${N}`)
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond library rm <id|number>`); process.exit(1) }
        const assets = await call(ws, 'library.list') as LibraryAsset[]
        const asset = findAsset(assets, query)
        if (!asset) { console.error(`${R}No matching asset:${N} ${query}`); process.exit(1) }
        const result = await call(ws, 'library.delete', { id: asset.id }) as { ok: boolean }
        if (result.ok) console.log(`${R}Deleted${N}  ${asset.title}`)
        else console.error(`${R}Failed to delete${N}`)
        break
      }

      case 'ref': {
        const refSub = args[1]
        switch (refSub) {
          case 'add': {
            const [assetQuery, itemId] = [args[2], args[3]]
            if (!assetQuery || !itemId) { console.error(`${R}Usage:${N} bond library ref add <assetId|number> <itemId>`); process.exit(1) }
            const assets = await call(ws, 'library.list') as LibraryAsset[]
            const asset = findAsset(assets, assetQuery)
            if (!asset) { console.error(`${R}No matching asset:${N} ${assetQuery}`); process.exit(1) }
            await call(ws, 'library.addReference', { assetId: asset.id, itemId })
            console.log(`${G}Referenced${N}  ${asset.title} → ${itemId}`)
            break
          }
          case 'rm': {
            const [assetQuery, itemId] = [args[2], args[3]]
            if (!assetQuery || !itemId) { console.error(`${R}Usage:${N} bond library ref rm <assetId|number> <itemId>`); process.exit(1) }
            const assets = await call(ws, 'library.list') as LibraryAsset[]
            const asset = findAsset(assets, assetQuery)
            if (!asset) { console.error(`${R}No matching asset:${N} ${assetQuery}`); process.exit(1) }
            const result = await call(ws, 'library.removeReference', { assetId: asset.id, itemId }) as { ok: boolean }
            if (result.ok) console.log(`${R}Unreferenced${N}  ${asset.title} ← ${itemId}`)
            else console.error(`${R}No such reference${N}`)
            break
          }
          case 'list': {
            const itemId = args[2]
            if (!itemId) { console.error(`${R}Usage:${N} bond library ref list <itemId>`); process.exit(1) }
            const refs = await call(ws, 'library.listReferencesForItem', { itemId }) as LibraryAsset[]
            if (refs.length === 0) { console.log(`${D}No references${N}`); break }
            refs.forEach(a => console.log(`  ${D}${a.id.slice(0, 8)}${N}  ${a.title}`))
            break
          }
          default:
            console.error(`${R}Usage:${N} bond library ref <add|rm|list> ...`)
            process.exit(1)
        }
        break
      }

      case 'backlinks': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond library backlinks <assetId|number>`); process.exit(1) }
        const assets = await call(ws, 'library.list') as LibraryAsset[]
        const asset = findAsset(assets, query)
        if (!asset) { console.error(`${R}No matching asset:${N} ${query}`); process.exit(1) }
        const backlinks = await call(ws, 'library.listBacklinksForAsset', { assetId: asset.id }) as
          { itemId: string; collectionName: string; itemKey: string | null; itemLabel: string }[]
        if (backlinks.length === 0) { console.log(`${D}No backlinks${N}`); break }
        backlinks.forEach(b => console.log(`  ${D}${b.collectionName}${N}  ${b.itemKey ?? b.itemLabel}`))
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond library [list|add|info|open|reveal|rm|ref|backlinks] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
