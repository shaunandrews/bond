import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setDataDir } from '../paths'
import { getDb, closeDb } from '../db'
import { createSenseController, type SenseControllerDeps } from './controller'
import type { WindowDetector, WindowSnapshot } from './window-detector'
import type { PresenceMonitor } from './presence'
import type { ClipboardMonitor } from './clipboard'
import type { DetectedWindow } from '../../shared/sense'

let testDir: string

const ACTIVE_WINDOW: DetectedWindow = {
  name: 'Studio',
  bundleId: 'com.automattic.studio',
  title: 'Studio — Sync Dialog',
  active: true,
  pid: 4242,
}

function fakePresence(): PresenceMonitor {
  const e = new EventEmitter() as PresenceMonitor
  e.getState = () => 'active'
  e.getIdleSeconds = () => 0
  e.start = () => {}
  e.stop = () => {}
  return e
}

function fakeWindowDetector(window: DetectedWindow = ACTIVE_WINDOW): WindowDetector {
  const e = new EventEmitter() as WindowDetector
  const snapshot: WindowSnapshot = {
    windows: [window],
    activeWindow: window,
    timestamp: new Date().toISOString(),
  }
  e.getSnapshot = async () => snapshot
  e.getLastSnapshot = () => snapshot
  e.startPolling = () => {}
  e.stopPolling = () => {}
  return e
}

function fakeClipboard(): ClipboardMonitor {
  const e = new EventEmitter() as ClipboardMonitor
  e.getLastText = () => null
  e.start = () => {}
  e.stop = () => {}
  return e
}

function fakeDeps(overrides: Partial<SenseControllerDeps> = {}): SenseControllerDeps {
  return {
    presence: fakePresence(),
    windowDetector: fakeWindowDetector(),
    clipboard: fakeClipboard(),
    textWorker: { start: () => {}, stop: () => {}, processNow: async () => {} },
    ...overrides,
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `bond-sense-ctrl-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  setDataDir(testDir)
  getDb()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  setDataDir(null as unknown as string)
})

/** Bring a controller from `disabled` to `recording` with one capture in flight. */
async function startRecording(deps: SenseControllerDeps) {
  const controller = createSenseController({ enabled: true }, deps)
  const requests: string[] = []
  controller.on('requestCapture', p => requests.push(p.captureId))
  controller.enable()
  // enable() defers its first reconcile by 1s
  await vi.advanceTimersByTimeAsync(1_000)
  return { controller, requests }
}

describe('sense controller — capture wedge', () => {
  it('emits a capture request once recording starts', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    expect(controller.getState()).toBe('recording')
    expect(requests).toHaveLength(1)
    controller.destroy()
  })

  it('refuses new captures while one is still pending', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    // Two interval ticks with no captureReady — both must be swallowed
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(15_000 - 1)
    expect(requests).toHaveLength(1)
    controller.destroy()
  })

  it('clears the wedge on timeout so the next interval tick still captures', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    const orphanId = requests[0]

    // Never call onCaptureReady. Past the 30s pending timeout, capture resumes.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(requests.length).toBeGreaterThan(1)
    expect(requests[requests.length - 1]).not.toBe(orphanId)

    // The imageless row it left behind is gone, not stranded in the timeline
    const orphan = getDb().prepare('SELECT id FROM sense_captures WHERE id = ?').get(orphanId)
    expect(orphan).toBeUndefined()
    controller.destroy()
  })

  it('clears the wedge immediately when main reports a failed screenshot', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    const orphanId = requests[0]

    controller.onCaptureFailed(orphanId, 'no_screen_source')

    await vi.advanceTimersByTimeAsync(15_000)
    expect(requests).toHaveLength(2)
    expect(getDb().prepare('SELECT id FROM sense_captures WHERE id = ?').get(orphanId)).toBeUndefined()
    controller.destroy()
  })

  it('ignores a failure report for a capture that is no longer pending', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    controller.onCaptureFailed('some-other-capture', 'stale')
    // The real pending capture survives, so the next tick is still blocked
    await vi.advanceTimersByTimeAsync(15_000)
    expect(requests).toHaveLength(1)
    controller.destroy()
  })

  it('does not delete a capture that already received its image', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    const captureId = requests[0]

    controller.onCaptureReady(captureId, join(testDir, 'shot.jpg'))
    await vi.advanceTimersByTimeAsync(60_000)

    const row = getDb().prepare('SELECT image_path FROM sense_captures WHERE id = ?').get(captureId) as
      | { image_path: string | null }
      | undefined
    expect(row?.image_path).toBe(join(testDir, 'shot.jpg'))
    controller.destroy()
  })
})

describe('sense controller — pid capture', () => {
  it('persists the active window pid so the accessibility path can run', async () => {
    const { controller, requests } = await startRecording(fakeDeps())
    const row = getDb().prepare('SELECT pid, window_title FROM sense_captures WHERE id = ?').get(requests[0]) as
      | { pid: number | null; window_title: string | null }
      | undefined
    expect(row?.pid).toBe(4242)
    expect(row?.window_title).toBe('Studio — Sync Dialog')
    controller.destroy()
  })

  it('stores a null pid when no window is active', async () => {
    const detector = fakeWindowDetector()
    detector.getSnapshot = async () => ({ windows: [], activeWindow: null, timestamp: new Date().toISOString() })
    const { controller, requests } = await startRecording(fakeDeps({ windowDetector: detector }))
    const row = getDb().prepare('SELECT pid FROM sense_captures WHERE id = ?').get(requests[0]) as
      | { pid: number | null }
      | undefined
    expect(row?.pid).toBeNull()
    controller.destroy()
  })
})

describe('sense controller — app-switch debounce', () => {
  it('suppresses a rapid burst of app switches within one capture interval', async () => {
    const detector = fakeWindowDetector()
    const { controller, requests } = await startRecording(fakeDeps({ windowDetector: detector }))
    // Free the pending slot so only the debounce (not the wedge) can block.
    controller.onCaptureReady(requests[0], join(testDir, 'a.jpg'))
    const before = requests.length

    // The old code fired one capture per app switch — 26x more captures than
    // actual transitions. Ten switches over ~2s, all inside the 15s interval.
    for (let i = 0; i < 10; i++) {
      detector.emit('appSwitch', ACTIVE_WINDOW, null)
      await vi.advanceTimersByTimeAsync(200)
    }

    expect(requests.length).toBe(before)
    controller.destroy()
  })

  it('still captures on an app switch once the interval has elapsed', async () => {
    const detector = fakeWindowDetector()
    const { controller, requests } = await startRecording(fakeDeps({ windowDetector: detector }))
    // Leave the initial capture pending so interval ticks are swallowed and the
    // debounce clock (the last actual capture) does not advance.
    await vi.advanceTimersByTimeAsync(18_000) // > the 15s interval, < the 30s wedge timeout
    controller.onCaptureReady(requests[0], join(testDir, 'a.jpg'))

    detector.emit('appSwitch', ACTIVE_WINDOW, null)
    await vi.advanceTimersByTimeAsync(1)

    expect(requests.length).toBeGreaterThan(1)
    controller.destroy()
  })
})
