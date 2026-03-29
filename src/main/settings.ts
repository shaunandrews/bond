import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const soulPath = () => join(app.getPath('userData'), 'soul.md')

export function getSoul(): string {
  const p = soulPath()
  if (!existsSync(p)) return ''
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

export function saveSoul(content: string): boolean {
  try {
    writeFileSync(soulPath(), content, 'utf-8')
    return true
  } catch {
    return false
  }
}
