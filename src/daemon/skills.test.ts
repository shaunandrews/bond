import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Mock paths to use temp directory
const testDir = join(tmpdir(), `bond-test-skills-${randomUUID()}`)
vi.mock('./paths', () => ({
  getSkillsDir: () => join(testDir, 'skills'),
}))

import { scanSkills, removeSkill } from './skills'

beforeEach(() => {
  mkdirSync(join(testDir, 'skills'), { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function createSkill(name: string, frontmatter: string): void {
  const dir = join(testDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), frontmatter)
}

describe('skills module', () => {
  describe('scanSkills', () => {
    it('returns empty array when no skills exist', () => {
      expect(scanSkills()).toEqual([])
    })

    it('scans skill with full frontmatter', () => {
      createSkill('test-skill', `---
name: test-skill
description: A test skill
argument-hint: <arg>
---

# Test Skill

Body content here.`)

      const skills = scanSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0]).toEqual({
        name: 'test-skill',
        description: 'A test skill',
        argumentHint: '<arg>',
      })
    })

    it('handles missing description and argument-hint', () => {
      createSkill('minimal', `---
name: minimal
---

Content.`)

      const skills = scanSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('minimal')
      expect(skills[0].description).toBe('')
      expect(skills[0].argumentHint).toBe('')
    })

    it('strips quotes from frontmatter values', () => {
      createSkill('quoted', `---
name: "quoted-skill"
description: 'A quoted description'
---`)

      const skills = scanSkills()
      expect(skills[0].name).toBe('quoted-skill')
      expect(skills[0].description).toBe('A quoted description')
    })

    it('skips directories without SKILL.md', () => {
      mkdirSync(join(testDir, 'skills', 'empty-dir'), { recursive: true })
      expect(scanSkills()).toEqual([])
    })

    it('skips skills without name in frontmatter', () => {
      createSkill('no-name', `---
description: Missing name field
---`)
      expect(scanSkills()).toEqual([])
    })

    it('scans multiple skills', () => {
      createSkill('alpha', `---
name: alpha
description: First skill
---`)
      createSkill('beta', `---
name: beta
description: Second skill
---`)

      const skills = scanSkills()
      expect(skills).toHaveLength(2)
      const names = skills.map(s => s.name)
      expect(names).toContain('alpha')
      expect(names).toContain('beta')
    })
  })

  describe('removeSkill', () => {
    it('removes existing skill directory', () => {
      createSkill('to-remove', `---
name: to-remove
---`)
      const dir = join(testDir, 'skills', 'to-remove')
      expect(existsSync(dir)).toBe(true)

      expect(removeSkill('to-remove')).toBe(true)
      expect(existsSync(dir)).toBe(false)
    })

    it('returns false for nonexistent skill', () => {
      expect(removeSkill('nonexistent')).toBe(false)
    })
  })
})
