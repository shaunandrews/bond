import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandOutputLimitError, runArgvCommand } from './command-runner'

const roots: string[] = []
function testRoot(): string {
  const root = join(process.cwd(), '.test-tmp', `bond-command-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('argv command runner', () => {
  it('forces cwd, never invokes a shell, and captures bounded output', async () => {
    const root = testRoot()
    const result = await runArgvCommand([process.execPath, '-e', 'process.stdout.write(process.cwd())'], {
      cwd: root,
      caps: { wallClockSeconds: 10, maxOutputChars: 1000 },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(root)
  })

  it('terminates the process group on cancellation', async () => {
    const controller = new AbortController()
    const root = testRoot()
    const pidFile = join(root, 'child.pid')
    const script = [
      'const {spawn}=require("child_process"),fs=require("fs");',
      'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});',
      'fs.writeFileSync("child.pid",String(child.pid));setInterval(()=>{},1000);',
    ].join('')
    const running = runArgvCommand([process.execPath, '-e', script], {
      cwd: root,
      signal: controller.signal,
      caps: { wallClockSeconds: 10, maxOutputChars: 1000 },
    })
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    controller.abort()
    await expect(running).rejects.toThrow('cancelled')
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  it('kills commands that exceed the output cap', async () => {
    await expect(runArgvCommand([process.execPath, '-e', 'process.stdout.write("x".repeat(1000))'], {
      cwd: testRoot(),
      caps: { wallClockSeconds: 10, maxOutputChars: 20 },
    })).rejects.toBeInstanceOf(CommandOutputLimitError)
  })
})
