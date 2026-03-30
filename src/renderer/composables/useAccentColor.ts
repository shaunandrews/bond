import { ref } from 'vue'

/** Default accent (warm brown) — used when no accent is saved */
const DEFAULT_ACCENT = '#7a5c3b'

const currentAccent = ref(DEFAULT_ACCENT)

/** Parse hex (#rgb or #rrggbb) → [r, g, b] 0-255 */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** RGB 0-255 → HSL (h: 0-360, s: 0-100, l: 0-100) */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s * 100, l * 100]
}

/** HSL → CSS hsl() string */
function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`
}

/**
 * Derive a full set of theme colors from a single accent hex.
 * Returns CSS variable values for both light and dark modes.
 */
function deriveTheme(accent: string) {
  const [r, g, b] = hexToRgb(accent)
  const [h, s] = rgbToHsl(r, g, b)

  // Tint strength — how much the accent hue bleeds into neutrals
  const tint = Math.min(s * 0.15, 12)

  return {
    light: {
      '--color-bg': hsl(h, tint, 96),
      '--color-surface': hsl(h, tint * 0.5, 100),
      '--color-border': hsl(h, tint, 85),
      '--color-text-primary': hsl(h, tint * 0.6, 12),
      '--color-muted': hsl(h, tint * 0.5, 42),
      '--color-accent': accent
    },
    dark: {
      '--color-bg': hsl(h, tint, 7),
      '--color-surface': hsl(h, tint, 11),
      '--color-border': hsl(h, tint * 0.8, 24),
      '--color-text-primary': hsl(h, tint * 0.4, 91),
      '--color-muted': hsl(h, tint * 0.4, 60),
      '--color-accent': lightenAccentForDark(accent)
    }
  }
}

/** Lighten the accent for dark mode so it remains visible */
function lightenAccentForDark(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  // Push lightness to at least 65, cap saturation to keep it pleasant
  const newL = Math.max(l, 65)
  const newS = Math.min(s, 55)
  return hsl(h, newS, newL)
}

/** Apply the derived theme via a dynamic <style> element (not inline styles) */
function applyTheme(accent: string) {
  const theme = deriveTheme(accent)

  let styleEl = document.getElementById('bond-accent-theme') as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'bond-accent-theme'
    document.head.appendChild(styleEl)
  }

  const lightVars = Object.entries(theme.light)
    .map(([k, v]) => `    ${k}: ${v};`)
    .join('\n')

  const darkVars = Object.entries(theme.dark)
    .map(([k, v]) => `    ${k}: ${v};`)
    .join('\n')

  styleEl.textContent = `:root {\n${lightVars}\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n${darkVars}\n  }\n}`
}

export function useAccentColor() {
  async function load() {
    const saved = await window.bond.getAccentColor()
    if (saved) {
      currentAccent.value = saved
    }
    applyTheme(currentAccent.value)
  }

  async function setAccent(hex: string) {
    currentAccent.value = hex
    applyTheme(hex)
    await window.bond.saveAccentColor(hex)
  }

  function reset() {
    return setAccent(DEFAULT_ACCENT)
  }

  return {
    accent: currentAccent,
    defaultAccent: DEFAULT_ACCENT,
    load,
    setAccent,
    reset
  }
}
