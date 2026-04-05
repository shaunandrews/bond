// --- Sense: Ambient Screen Awareness ---

export interface SenseSession {
  id: string
  startedAt: string       // ISO 8601
  endedAt?: string        // ISO 8601, null while active
  captureCount: number
  createdAt: string
}

export interface SenseCapture {
  id: string
  sessionId: string
  capturedAt: string      // ISO 8601
  imagePath?: string      // null after retention purge
  appName?: string
  appBundleId?: string
  windowTitle?: string
  visibleWindows: string[] // all visible window names
  textSource: 'pending' | 'accessibility' | 'ocr' | 'both' | 'failed'
  textStatus: 'pending' | 'processing' | 'done' | 'failed'
  textContent?: string    // extracted text, survives image purge
  captureTrigger?: 'app_switch' | 'interval' | 'clipboard'
  ambiguous: boolean      // true if active window changed mid-capture
  imagePurgedAt?: string  // set when image deleted by retention cleanup
  createdAt: string
}

export interface SenseSettings {
  enabled: boolean
  captureIntervalSeconds: number
  lowPowerIntervalSeconds: number
  idleThresholdSeconds: number
  eventDrivenCapture: boolean
  retentionDays: number
  textRetentionDays: number
  storageCapMb: number
  blacklistedApps: string[]
  autoContextInChat: boolean
  clipboardCapture: boolean
  textExtractionPreference: 'auto' | 'accessibility' | 'ocr'
}

export const DEFAULT_SENSE_SETTINGS: SenseSettings = {
  enabled: false,
  captureIntervalSeconds: 15,
  lowPowerIntervalSeconds: 30,
  idleThresholdSeconds: 60,
  eventDrivenCapture: true,
  retentionDays: 14,
  textRetentionDays: 90,
  storageCapMb: 2048,
  blacklistedApps: [],
  autoContextInChat: false,
  clipboardCapture: true,
  textExtractionPreference: 'auto',
}

export type SenseState = 'disabled' | 'armed' | 'recording' | 'idle' | 'paused' | 'suspended'

export interface SenseStatus {
  enabled: boolean
  state: SenseState
  lastCapture?: SenseCapture
  sessionCount: number
  storageBytes: number
}

// Window detection output from bond-window-helper
export interface DetectedWindow {
  name: string
  bundleId: string
  title: string
  active: boolean
  pid: number
}

// OCR output from bond-ocr-helper
export interface OcrResult {
  meta: {
    imageWidth: number
    imageHeight: number
    languages: string[]
    confidence: number
  }
  lines: string[]
}

// Accessibility tree output from bond-accessibility-helper
export interface AccessibilityElement {
  type: string        // text, label, heading, value, button, etc.
  value: string
  depth: number
}

export interface AccessibilityResult {
  app: string
  pid: number
  elements: AccessibilityElement[]
}

// App text quality cache — tracks which apps produce good accessibility data
export interface AppTextQuality {
  bundleId: string
  preferredSource: 'accessibility' | 'ocr'
  avgAccessibilityChars: number
  sampleCount: number
  updatedAt: string
}

// Default blacklisted apps (bundle IDs)
export const DEFAULT_BLACKLISTED_APPS = [
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'org.keepassxc.keepassxc',
  'com.lastpass.LastPass',
  'com.apple.keychainaccess',
]
