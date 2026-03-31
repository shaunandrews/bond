<script setup lang="ts">
import type { WpThemeJson } from '../../shared/wordpress'
import BondText from './BondText.vue'

defineProps<{
  themeJson: WpThemeJson
}>()

function contrastClass(hex: string): string {
  const c = hex.replace('#', '')
  if (c.length < 6) return 'light-text'
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? 'dark-text' : 'light-text'
}

function firstFontFamily(fontFamily: string): string {
  return fontFamily.split(',')[0].replace(/['"]/g, '').trim()
}
</script>

<template>
  <div class="theme-tokens-view">
    <!-- Colors -->
    <div v-if="themeJson.colors.length" class="tokens-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Colors</BondText>
      <div class="color-grid">
        <div
          v-for="color in themeJson.colors"
          :key="color.slug"
          class="color-swatch"
          :class="contrastClass(color.color)"
          :style="{ background: color.color }"
        >
          <span class="swatch-name">{{ color.name }}</span>
          <span class="swatch-value">{{ color.color }}</span>
        </div>
      </div>
    </div>

    <!-- Typography -->
    <div v-if="themeJson.fontFamilies.length" class="tokens-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Fonts</BondText>
      <div class="font-list">
        <div v-for="font in themeJson.fontFamilies" :key="font.slug" class="font-card">
          <div class="font-specimen" :style="{ fontFamily: font.fontFamily }">Aa</div>
          <div class="font-meta">
            <BondText size="sm" weight="medium">{{ font.name }}</BondText>
            <BondText size="xs" color="muted" mono>{{ firstFontFamily(font.fontFamily) }}</BondText>
          </div>
        </div>
      </div>
    </div>

    <!-- Font Sizes -->
    <div v-if="themeJson.fontSizes.length" class="tokens-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Font Sizes</BondText>
      <div class="size-list">
        <div v-for="size in themeJson.fontSizes" :key="size.slug" class="size-row">
          <BondText size="sm" color="muted" class="size-label">{{ size.name || size.slug }}</BondText>
          <BondText size="sm" :style="{ fontSize: size.size }" class="size-specimen">Aa</BondText>
          <BondText size="xs" color="muted" mono>{{ size.size }}</BondText>
        </div>
      </div>
    </div>

    <!-- Spacing -->
    <div v-if="themeJson.spacingSizes.length" class="tokens-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Spacing</BondText>
      <div class="spacing-list">
        <div v-for="sp in themeJson.spacingSizes" :key="sp.slug" class="spacing-row">
          <BondText size="xs" color="muted" class="spacing-label">{{ sp.name || sp.slug }}</BondText>
          <div class="spacing-bar" :style="{ width: sp.size }"></div>
          <BondText size="xs" color="muted" mono>{{ sp.size }}</BondText>
        </div>
      </div>
    </div>

    <!-- Layout -->
    <div v-if="themeJson.contentWidth || themeJson.wideWidth" class="tokens-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Layout</BondText>
      <div class="layout-details">
        <div v-if="themeJson.contentWidth" class="detail-row">
          <BondText size="sm" color="muted">Content width</BondText>
          <BondText size="sm" mono>{{ themeJson.contentWidth }}</BondText>
        </div>
        <div v-if="themeJson.wideWidth" class="detail-row">
          <BondText size="sm" color="muted">Wide width</BondText>
          <BondText size="sm" mono>{{ themeJson.wideWidth }}</BondText>
        </div>
      </div>
    </div>

    <div v-if="!themeJson.colors.length && !themeJson.fontFamilies.length && !themeJson.fontSizes.length && !themeJson.spacingSizes.length && !themeJson.contentWidth && !themeJson.wideWidth" class="tokens-empty">
      <BondText size="sm" color="muted">No design tokens found in this theme.</BondText>
    </div>
  </div>
</template>

<style scoped>
.theme-tokens-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.tokens-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* Colors */
.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.5rem;
}

.color-swatch {
  border-radius: var(--radius-lg);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-height: 4.5rem;
  justify-content: flex-end;
  border: 1px solid var(--color-border);
}

.color-swatch.dark-text .swatch-name,
.color-swatch.dark-text .swatch-value {
  color: rgba(0, 0, 0, 0.8);
}
.color-swatch.light-text .swatch-name,
.color-swatch.light-text .swatch-value {
  color: rgba(255, 255, 255, 0.9);
}

.swatch-name {
  font-size: 0.75rem;
  font-weight: 500;
}
.swatch-value {
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  opacity: 0.75;
}

/* Fonts */
.font-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.font-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}

.font-specimen {
  font-size: 1.75rem;
  line-height: 1;
  color: var(--color-text-primary);
  min-width: 2.5rem;
  text-align: center;
}

.font-meta {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

/* Font Sizes */
.size-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.size-row {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.size-label {
  min-width: 5rem;
  flex-shrink: 0;
}

.size-specimen {
  color: var(--color-text-primary);
  line-height: 1.2;
}

/* Spacing */
.spacing-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.spacing-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.spacing-label {
  min-width: 3rem;
  flex-shrink: 0;
}

.spacing-bar {
  height: 0.5rem;
  background: var(--color-accent);
  border-radius: var(--radius-sm);
  min-width: 2px;
  max-width: 100%;
}

/* Layout */
.layout-details {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
}
.detail-row:last-child {
  border-bottom: none;
}

.tokens-empty {
  padding: 0.5rem 0;
}
</style>
