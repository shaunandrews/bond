#!/usr/bin/env node

/**
 * bond media — CLI for managing Bond media library via the daemon.
 *
 * Usage:
 *   bond media                     List all images
 *   bond media add <path|url>      Import from local file or URL (also accepts - for stdin)
 *   bond media info <id|number>    Show details for an image
 *   bond media open <id|number>    Open an image in Preview
 *   bond media rm <id|number>      Delete an image
 *   bond media purge               Delete all images
 */

import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import WebSocket from 'ws'

const SOCK = join(homedir(), '.bond', 'bond.sock')
const IMAGES_DIR = join(homedir(), 'Library', 'Application Support', 'bond', 'images')

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

interface ImageRecord {
  id: string
  sessionId: string
  filename: string
  mediaType: string
  sizeBytes: number
  createdAt: string
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${SOCK}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', (err) => reject(err))
  })
}

function findImage(images: ImageRecord[], query: string): ImageRecord | undefined {
  // Numeric index (1-based)
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= images.length) return images[idx - 1]
  // ID prefix match
  const lower = query.toLowerCase()
  return images.find(i => i.id.toLowerCase().startsWith(lower))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function detectMediaType(buf: Buffer): string | undefined {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return undefined
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
        const images = await call(ws, 'image.list') as ImageRecord[]
        if (images.length === 0) {
          console.log(`${D}No images${N}`)
          break
        }
        const totalBytes = images.reduce((sum, i) => sum + i.sizeBytes, 0)
        console.log(`  ${D}${images.length} image${images.length === 1 ? '' : 's'} · ${formatSize(totalBytes)}${N}\n`)
        images.forEach((img, i) => {
          const date = formatDate(img.createdAt)
          const size = formatSize(img.sizeBytes)
          console.log(`  ${D}${i + 1}.${N}  ${size.padEnd(10)} ${date.padEnd(24)} ${D}${img.filename}${N}`)
        })
        break
      }

      case 'info': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond media info <id|number>`); process.exit(1) }
        const images = await call(ws, 'image.list') as ImageRecord[]
        const img = findImage(images, query)
        if (!img) { console.error(`${R}No matching image:${N} ${query}`); process.exit(1) }
        console.log(`  ${B}ID${N}         ${img.id}`)
        console.log(`  ${B}File${N}       ${img.filename}`)
        console.log(`  ${B}Type${N}       ${img.mediaType}`)
        console.log(`  ${B}Size${N}       ${formatSize(img.sizeBytes)}`)
        console.log(`  ${B}Created${N}    ${formatDate(img.createdAt)}`)
        console.log(`  ${B}Session${N}    ${img.sessionId}`)
        console.log(`  ${B}Path${N}       ${join(IMAGES_DIR, img.filename)}`)
        break
      }

      case 'open': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond media open <id|number>`); process.exit(1) }
        const images = await call(ws, 'image.list') as ImageRecord[]
        const img = findImage(images, query)
        if (!img) { console.error(`${R}No matching image:${N} ${query}`); process.exit(1) }
        const path = join(IMAGES_DIR, img.filename)
        execSync(`open "${path}"`)
        console.log(`${G}Opened${N}  ${img.filename}`)
        break
      }

      case 'add':
      case 'download': {
        const source = args[1]
        if (!source) {
          console.error(`${R}Usage:${N} bond media add <path|url>`)
          console.error(`  Accepts local files, URLs, or stdin (bond media add -)`)
          process.exit(1)
        }

        const extMap: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
          '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
        }
        const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

        let buf: Buffer
        let mediaType: string | undefined

        if (source === '-') {
          // Read from stdin
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
          buf = Buffer.concat(chunks)
          // Try to detect from magic bytes
          mediaType = detectMediaType(buf)
        } else if (/^https?:\/\//i.test(source)) {
          // URL — fetch it
          let response: Response
          try {
            response = await fetch(source, {
              headers: { 'User-Agent': 'Bond/1.0' },
              redirect: 'follow'
            })
          } catch (err) {
            console.error(`${R}Failed to fetch:${N} ${err instanceof Error ? err.message : err}`)
            process.exit(1)
          }

          if (!response.ok) {
            console.error(`${R}HTTP ${response.status}${N} ${response.statusText}`)
            process.exit(1)
          }

          const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
          const urlExt = '.' + source.split('?')[0].split('.').pop()?.toLowerCase()
          mediaType = (contentType && supportedTypes.includes(contentType))
            ? contentType
            : extMap[urlExt]

          buf = Buffer.from(await response.arrayBuffer())
        } else {
          // Local file path — resolve ~ and check existence
          const filePath = source.startsWith('~') ? join(homedir(), source.slice(1)) : source
          if (!existsSync(filePath)) {
            console.error(`${R}File not found:${N} ${filePath}`)
            process.exit(1)
          }
          const stat = statSync(filePath)
          if (!stat.isFile()) {
            console.error(`${R}Not a file:${N} ${filePath}`)
            process.exit(1)
          }

          const ext = extname(filePath).toLowerCase()
          mediaType = extMap[ext]
          buf = readFileSync(filePath)

          // Fall back to magic byte detection
          if (!mediaType) mediaType = detectMediaType(buf)
        }

        if (!mediaType) {
          console.error(`${R}Unsupported image type${N} (supported: jpeg, png, gif, webp)`)
          process.exit(1)
        }

        const data = buf.toString('base64')
        const result = await call(ws, 'image.import', { data, mediaType }) as ImageRecord
        console.log(`${G}Added${N}  ${formatSize(buf.length)}  ${D}${result.id}${N}`)
        break
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        const query = args[1]
        if (!query) { console.error(`${R}Usage:${N} bond media rm <id|number>`); process.exit(1) }
        const images = await call(ws, 'image.list') as ImageRecord[]
        const img = findImage(images, query)
        if (!img) { console.error(`${R}No matching image:${N} ${query}`); process.exit(1) }
        const ok = await call(ws, 'image.delete', { id: img.id })
        if (ok) console.log(`${R}Deleted${N}  ${img.filename} (${formatSize(img.sizeBytes)})`)
        else console.error(`${R}Failed to delete${N}`)
        break
      }

      case 'purge': {
        const images = await call(ws, 'image.list') as ImageRecord[]
        if (images.length === 0) {
          console.log(`${D}No images to delete${N}`)
          break
        }
        let deleted = 0
        for (const img of images) {
          const ok = await call(ws, 'image.delete', { id: img.id })
          if (ok) deleted++
        }
        console.log(`${R}Purged${N}  ${deleted} image${deleted === 1 ? '' : 's'}`)
        break
      }

      default:
        console.error(`${R}Unknown subcommand:${N} ${sub}`)
        console.log(`\nUsage: bond media [list|add|info|open|rm|purge] [args...]`)
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main()
