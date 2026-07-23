/**
 * Sense tray indicator — menu bar icon showing Sense state.
 * State is driven by daemon WebSocket events.
 */

import { Tray, Menu, Notification, nativeImage } from 'electron'
import type { BondClient } from '../shared/client'
import type { AgentRun, AgentRunState } from '../shared/agent-runs'

let tray: Tray | null = null
let currentState = 'disabled'
const notifiedAgentStates = new Map<string, AgentRunState>()

export function shouldNotifyAgentRun(previous: AgentRunState | undefined, next: AgentRunState, appFocused: boolean): boolean {
  if (appFocused || previous === next) return false
  return ['needs-input', 'succeeded', 'failed'].includes(next)
}

function notifyAgentRun(run: AgentRun, appFocused: boolean): void {
  const previous = notifiedAgentStates.get(run.id)
  notifiedAgentStates.set(run.id, run.status)
  if (!shouldNotifyAgentRun(previous, run.status, appFocused) || !Notification.isSupported()) return
  const outcome = run.status === 'needs-input' ? 'needs your input' : run.status === 'succeeded' ? 'finished' : 'failed'
  new Notification({ title: `${run.agentLabel} ${outcome}`, body: run.status === 'failed' ? run.errorMessage ?? run.brief : run.brief, silent: true }).show()
}

// Simple dot icons for tray (template images for macOS)
function createTrayIcon(state: string): Electron.NativeImage {
  // 22x22 template image (macOS convention)
  // Use a simple circle indicator
  const size = 22
  const canvas = Buffer.alloc(size * size * 4) // RGBA

  // Draw a small circle in the center
  const cx = size / 2
  const cy = size / 2
  const r = 4

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const offset = (y * size + x) * 4

      if (dist <= r) {
        // Filled circle
        const alpha = dist > r - 1 ? Math.max(0, (r - dist) * 255) : 255
        canvas[offset] = 0     // R (template images are monochrome)
        canvas[offset + 1] = 0 // G
        canvas[offset + 2] = 0 // B
        canvas[offset + 3] = Math.round(alpha) // A
      }
    }
  }

  const img = nativeImage.createFromBuffer(canvas, { width: size, height: size })
  img.setTemplateImage(true)
  return img
}

function buildContextMenu(client: BondClient): Electron.Menu {
  const stateLabel = currentState.charAt(0).toUpperCase() + currentState.slice(1)

  return Menu.buildFromTemplate([
    { label: `Sense: ${stateLabel}`, enabled: false },
    { type: 'separator' },
    {
      label: currentState === 'disabled' ? 'Enable Sense' : 'Disable Sense',
      click: async () => {
        if (currentState === 'disabled') {
          await client.senseEnable()
        } else {
          await client.senseDisable()
        }
      }
    },
    ...(currentState === 'recording' || currentState === 'armed' ? [{
      label: 'Pause (10 min)',
      click: async () => { await client.sensePause(10) }
    }] : []),
    ...(currentState === 'paused' ? [{
      label: 'Resume',
      click: async () => { await client.senseResume() }
    }] : []),
  ])
}

export function initTray(client: BondClient, isAppFocused: () => boolean = () => false): void {
  const icon = createTrayIcon('disabled')
  tray = new Tray(icon)
  tray.setToolTip('Bond Sense')
  tray.setContextMenu(buildContextMenu(client))

  // Listen for state changes from daemon
  client.onSenseStateChanged((payload) => {
    currentState = payload.state
    if (tray) {
      tray.setContextMenu(buildContextMenu(client))
      // Update tooltip
      const label = currentState.charAt(0).toUpperCase() + currentState.slice(1)
      tray.setToolTip(`Bond Sense: ${label}`)
    }
  })
  client.onChunk(chunk => {
    if (chunk.kind === 'agent_run_changed') notifyAgentRun(chunk.run, isAppFocused())
  })

  // Get initial state
  client.senseStatus().then(status => {
    currentState = status.state
    if (tray) {
      tray.setContextMenu(buildContextMenu(client))
    }
  }).catch(() => {})
}

export function destroyTray(): void {
  notifiedAgentStates.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
}
