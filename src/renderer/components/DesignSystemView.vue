<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface Token {
  name: string
  value: string
}

const colorTokens = ref<Token[]>([])
const radiusTokens = ref<Token[]>([])
const shadowTokens = ref<Token[]>([])
const fontTokens = ref<Token[]>([])
const transitionTokens = ref<Token[]>([])

const colorNames = ['bg', 'surface', 'border', 'text-primary', 'muted', 'accent', 'err', 'ok']
const radiusNames = ['sm', 'md', 'lg', 'xl']
const shadowNames = ['sm', 'md', 'lg']
const fontNames = ['sans', 'mono']
const transitionNames = ['fast', 'base']

function readTokens() {
  const style = getComputedStyle(document.documentElement)

  colorTokens.value = colorNames.map(name => ({
    name: `--color-${name}`,
    value: style.getPropertyValue(`--color-${name}`).trim()
  }))

  radiusTokens.value = radiusNames.map(name => ({
    name: `--radius-${name}`,
    value: style.getPropertyValue(`--radius-${name}`).trim()
  }))

  shadowTokens.value = shadowNames.map(name => ({
    name: `--shadow-${name}`,
    value: style.getPropertyValue(`--shadow-${name}`).trim()
  }))

  fontTokens.value = fontNames.map(name => ({
    name: `--font-${name}`,
    value: style.getPropertyValue(`--font-${name}`).trim()
  }))

  transitionTokens.value = transitionNames.map(name => ({
    name: `--transition-${name}`,
    value: style.getPropertyValue(`--transition-${name}`).trim()
  }))
}

let mql: MediaQueryList | undefined

onMounted(() => {
  readTokens()
  mql = window.matchMedia('(prefers-color-scheme: dark)')
  mql.addEventListener('change', readTokens)
})

onUnmounted(() => {
  mql?.removeEventListener('change', readTokens)
})

function contrastClass(color: string): string {
  // Simple luminance check for text color on swatches
  const hex = color.replace('#', '')
  if (hex.length < 6) return 'dark-text'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? 'dark-text' : 'light-text'
}
</script>

<template>
  <div class="ds-view">
    <header class="ds-header">
      <h1>Design System</h1>
      <p>Living reference for Bond's visual language. Tokens defined in <code>app.css</code> and consumed via Tailwind utilities and CSS variables.</p>
    </header>

    <!-- Colors -->
    <section class="ds-section">
      <h2>Colors</h2>
      <p class="ds-description">Semantic color tokens. Dark mode variants are applied automatically via <code>prefers-color-scheme</code>.</p>
      <div class="ds-color-grid">
        <div
          v-for="token in colorTokens"
          :key="token.name"
          class="ds-color-swatch"
          :style="{ background: `var(${token.name})` }"
          :class="contrastClass(token.value)"
        >
          <span class="ds-swatch-name">{{ token.name.replace('--color-', '') }}</span>
          <span class="ds-swatch-value">{{ token.value }}</span>
        </div>
      </div>
    </section>

    <!-- Typography -->
    <section class="ds-section">
      <h2>Typography</h2>
      <p class="ds-description">Two font stacks: <code>--font-sans</code> for UI and <code>--font-mono</code> for code.</p>

      <div class="ds-type-group">
        <h3>Sans</h3>
        <div class="ds-type-stack" style="font-family: var(--font-sans)">
          <p class="ds-type-sample" style="font-size: 1.5rem; font-weight: 600">The quick brown fox (1.5rem / 600)</p>
          <p class="ds-type-sample" style="font-size: 1.15rem; font-weight: 600">The quick brown fox (1.15rem / 600)</p>
          <p class="ds-type-sample" style="font-size: 1rem; font-weight: 500">The quick brown fox (1rem / 500)</p>
          <p class="ds-type-sample" style="font-size: 0.875rem; font-weight: 400">The quick brown fox (0.875rem / 400)</p>
          <p class="ds-type-sample" style="font-size: 0.75rem; font-weight: 400">The quick brown fox (0.75rem / 400)</p>
        </div>
      </div>

      <div class="ds-type-group">
        <h3>Mono</h3>
        <div class="ds-type-stack" style="font-family: var(--font-mono)">
          <p class="ds-type-sample" style="font-size: 1rem">const bond = await createAgent()</p>
          <p class="ds-type-sample" style="font-size: 0.88rem">const bond = await createAgent()</p>
          <p class="ds-type-sample" style="font-size: 0.75rem">const bond = await createAgent()</p>
        </div>
      </div>

      <div class="ds-type-group">
        <h3>Font Stacks</h3>
        <div class="ds-token-list">
          <div v-for="token in fontTokens" :key="token.name" class="ds-token-row">
            <code>{{ token.name }}</code>
            <span class="ds-token-value">{{ token.value }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Border Radius -->
    <section class="ds-section">
      <h2>Border Radius</h2>
      <p class="ds-description">Consistent rounding scale used across all components.</p>
      <div class="ds-radius-row">
        <div
          v-for="token in radiusTokens"
          :key="token.name"
          class="ds-radius-box"
          :style="{ borderRadius: `var(${token.name})` }"
        >
          <span class="ds-radius-label">{{ token.name.replace('--radius-', '') }}</span>
          <span class="ds-radius-value">{{ token.value }}</span>
        </div>
      </div>
    </section>

    <!-- Shadows -->
    <section class="ds-section">
      <h2>Shadows</h2>
      <p class="ds-description">Elevation scale. Dark mode uses stronger shadows to maintain depth perception.</p>
      <div class="ds-shadow-row">
        <div
          v-for="token in shadowTokens"
          :key="token.name"
          class="ds-shadow-card"
          :style="{ boxShadow: `var(${token.name})` }"
        >
          <span class="ds-shadow-label">{{ token.name.replace('--shadow-', '') }}</span>
          <span class="ds-shadow-value">{{ token.value }}</span>
        </div>
      </div>
    </section>

    <!-- Transitions -->
    <section class="ds-section">
      <h2>Transitions</h2>
      <p class="ds-description">Timing tokens for consistent interaction feedback.</p>
      <div class="ds-transition-row">
        <div
          v-for="token in transitionTokens"
          :key="token.name"
          class="ds-transition-demo"
        >
          <div
            class="ds-transition-box"
            :style="{ transition: `background var(${token.name}), transform var(${token.name})` }"
          />
          <code>{{ token.name.replace('--transition-', '') }}</code>
          <span class="ds-token-value">{{ token.value }}</span>
        </div>
      </div>
    </section>

    <!-- Spacing -->
    <section class="ds-section">
      <h2>Spacing</h2>
      <p class="ds-description">Uses Tailwind's default 4px base scale. Visual reference for common values.</p>
      <div class="ds-spacing-list">
        <div v-for="size in [4, 8, 12, 16, 20, 24, 32, 40, 48]" :key="size" class="ds-spacing-item">
          <div class="ds-spacing-bar" :style="{ width: `${size}px` }" />
          <span class="ds-spacing-label">{{ size }}px</span>
          <span class="ds-spacing-class">{{ size / 4 }}</span>
        </div>
      </div>
    </section>

    <!-- All Tokens -->
    <section class="ds-section">
      <h2>All Tokens</h2>
      <p class="ds-description">Complete token reference with resolved values.</p>
      <table class="ds-token-table">
        <thead>
          <tr>
            <th>Token</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="token in [...colorTokens, ...fontTokens, ...radiusTokens, ...shadowTokens, ...transitionTokens]" :key="token.name">
            <td><code>{{ token.name }}</code></td>
            <td>{{ token.value }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.ds-view {
  flex: 1;
  min-width: 0;
  max-width: 960px;
  height: 100vh;
  overflow-y: auto;
  padding: 2rem 2.5rem 4rem;
}

.ds-header {
  margin-bottom: 2.5rem;
}
.ds-header h1 {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
}
.ds-header p {
  color: var(--color-muted);
  font-size: 0.875rem;
  margin: 0;
  line-height: 1.5;
}
.ds-header code {
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.85em;
}

.ds-section {
  margin-bottom: 2.5rem;
}
.ds-section h2 {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
}
.ds-section h3 {
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
  color: var(--color-muted);
}
.ds-description {
  color: var(--color-muted);
  font-size: 0.8rem;
  margin: 0 0 1rem;
  line-height: 1.5;
}
.ds-description code {
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.85em;
}

/* Colors */
.ds-color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
}
.ds-color-swatch {
  aspect-ratio: 1.4;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 0.15rem;
}
.ds-color-swatch.dark-text { color: var(--color-text-primary); }
.ds-color-swatch.light-text { color: #fff; }
.ds-swatch-name {
  font-size: 0.8rem;
  font-weight: 600;
}
.ds-swatch-value {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  opacity: 0.8;
}

/* Typography */
.ds-type-group {
  margin-bottom: 1.5rem;
}
.ds-type-stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.ds-type-sample {
  margin: 0;
  line-height: 1.4;
}

.ds-token-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.ds-token-row {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  font-size: 0.8rem;
}
.ds-token-row code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 0.15em 0.4em;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.ds-token-value {
  color: var(--color-muted);
  font-size: 0.75rem;
  word-break: break-all;
}

/* Border Radius */
.ds-radius-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.ds-radius-box {
  width: 80px;
  height: 80px;
  border: 2px solid var(--color-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
}
.ds-radius-label {
  font-size: 0.8rem;
  font-weight: 600;
}
.ds-radius-value {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  color: var(--color-muted);
}

/* Shadows */
.ds-shadow-row {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.ds-shadow-card {
  width: 120px;
  height: 80px;
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
}
.ds-shadow-label {
  font-size: 0.8rem;
  font-weight: 600;
}
.ds-shadow-value {
  font-size: 0.65rem;
  font-family: var(--font-mono);
  color: var(--color-muted);
  text-align: center;
  padding: 0 0.5rem;
  word-break: break-all;
}

/* Transitions */
.ds-transition-row {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.ds-transition-demo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}
.ds-transition-demo code {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 0.15em 0.4em;
  border-radius: var(--radius-sm);
}
.ds-transition-box {
  width: 48px;
  height: 48px;
  background: var(--color-border);
  border-radius: var(--radius-md);
}
.ds-transition-box:hover {
  background: var(--color-accent);
  transform: scale(1.1);
}

/* Spacing */
.ds-spacing-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.ds-spacing-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.ds-spacing-bar {
  height: 12px;
  background: var(--color-accent);
  border-radius: 2px;
  flex-shrink: 0;
}
.ds-spacing-label {
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--color-muted);
  min-width: 3rem;
}
.ds-spacing-class {
  font-size: 0.7rem;
  color: var(--color-muted);
  opacity: 0.6;
}

/* Token table */
.ds-token-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.ds-token-table th,
.ds-token-table td {
  border: 1px solid var(--color-border);
  padding: 0.4em 0.75em;
  text-align: left;
}
.ds-token-table th {
  font-weight: 600;
  background: color-mix(in srgb, var(--color-border) 30%, transparent);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
}
.ds-token-table code {
  font-family: var(--font-mono);
  font-size: 0.85em;
}
.ds-token-table td:last-child {
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  word-break: break-all;
}
</style>
