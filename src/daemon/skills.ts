import { readdirSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSkillsDir } from './paths'

export interface SkillInfo {
  name: string
  description: string
  argumentHint: string
}

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Handles simple `key: value` pairs between `---` delimiters.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

/**
 * Scan ~/.bond/skills/ for SKILL.md files and return metadata.
 */
export function scanSkills(): SkillInfo[] {
  const dir = getSkillsDir()
  if (!existsSync(dir)) return []

  const skills: SkillInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const skillFile = join(dir, entry, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      const content = readFileSync(skillFile, 'utf-8')
      const fm = parseFrontmatter(content)
      if (fm.name) {
        skills.push({
          name: fm.name,
          description: fm.description ?? '',
          argumentHint: fm['argument-hint'] ?? ''
        })
      }
    } catch { /* skip unreadable skills */ }
  }

  return skills
}

/**
 * Remove a skill directory from disk.
 */
export function removeSkill(name: string): boolean {
  const dir = join(getSkillsDir(), name)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}
