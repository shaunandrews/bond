import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDataDir } from '../paths'
import { type CoreMemory } from './types'
import { validateCoreMemory } from './parser'

export function coreMemoryPath(baseDir = getDataDir()): string {
  return join(baseDir, 'memory', 'core.json')
}

export function emptyCoreMemory(): CoreMemory {
  return { version: 1, facts: [], preferences: [], decisions: [], updatedAt: new Date().toISOString() }
}

export function readCoreMemory(path = coreMemoryPath()): CoreMemory {
  if (!existsSync(path)) return emptyCoreMemory()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return emptyCoreMemory()
  }
  const validated = validateCoreMemory(parsed)
  return validated.ok ? validated.value : emptyCoreMemory()
}

export function writeCoreMemoryAtomic(memory: CoreMemory, path = coreMemoryPath()): CoreMemory {
  const validated = validateCoreMemory({ ...memory, updatedAt: memory.updatedAt || new Date().toISOString() })
  if (!validated.ok) throw new Error(`Invalid core memory: ${validated.errors.join('; ')}`)

  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  const body = `${JSON.stringify(validated.value, null, 2)}\n`
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, path)
  return validated.value
}

export function updateCoreMemory(mutator: (current: CoreMemory) => CoreMemory, path = coreMemoryPath()): CoreMemory {
  const next = mutator(readCoreMemory(path))
  return writeCoreMemoryAtomic(next, path)
}
