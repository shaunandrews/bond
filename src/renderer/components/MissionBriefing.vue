<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

const quotes = [
  { text: 'Shaken, not stirred.', source: 'Dr. No' },
  { text: 'The name is Bond. James Bond.', source: 'Dr. No' },
  { text: 'I never miss.', source: 'Goldfinger' },
  { text: 'Do you expect me to talk?', source: 'Goldfinger' },
  { text: 'A martini. Shaken, not stirred.', source: 'Goldfinger' },
  { text: 'Nobody does it better.', source: 'The Spy Who Loved Me' },
  { text: 'I think he got the point.', source: 'Thunderball' },
  { text: 'World domination. Same old dream.', source: 'Dr. No' },
  { text: 'Keeping the British end up, sir.', source: 'The Spy Who Loved Me' },
  { text: 'I admire your courage, Miss…?', source: 'GoldenEye' },
  { text: 'Vodka martini. Shaken, not stirred.', source: 'Casino Royale' },
  { text: 'Everybody needs a hobby.', source: 'Skyfall' },
  { text: 'The things I do for England.', source: 'Casino Royale' },
]

const pick = Math.floor(Math.random() * quotes.length)
const quote = quotes[pick]

// Generate a mission number from session count stored in localStorage
const missionNumber = computed(() => {
  const count = parseInt(localStorage.getItem('bond:sessionCount') ?? '0', 10)
  const num = String(count + 1).padStart(3, '0')
  return num
})

const visible = ref(false)

onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

defineExpose({ visible })
</script>

<template>
  <Transition name="briefing-fade">
    <div v-if="visible" class="mission-briefing">
      <div class="briefing-watermark">TOP SECRET</div>

      <div class="briefing-content">
        <div class="briefing-header">
          <div class="briefing-stamp">CLASSIFIED</div>
          <div class="briefing-divider"></div>
          <div class="briefing-mission">MISSION {{ missionNumber }}</div>
        </div>

        <blockquote class="briefing-quote">
          <p>"{{ quote.text }}"</p>
          <cite>— {{ quote.source }}</cite>
        </blockquote>

        <div class="briefing-footer">
          <span class="briefing-dot"></span>
          <span class="briefing-hint">Awaiting orders…</span>
          <span class="briefing-dot"></span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.mission-briefing {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  min-height: calc(100vh - 200px);
  user-select: none;
  overflow: hidden;
}

/* Large watermark behind everything */
.briefing-watermark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-18deg);
  font-size: clamp(48px, 10vw, 120px);
  font-weight: 900;
  letter-spacing: 0.15em;
  color: var(--color-text-primary);
  opacity: 0.03;
  white-space: nowrap;
  pointer-events: none;
}

/* Foreground content */
.briefing-content {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  max-width: 360px;
  text-align: center;
}

.briefing-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.briefing-stamp {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3em;
  color: var(--color-muted);
  opacity: 0.5;
  border: 1px solid currentColor;
  padding: 2px 10px;
  border-radius: 2px;
}

.briefing-divider {
  width: 32px;
  height: 1px;
  background: var(--color-border);
  margin-top: 4px;
}

.briefing-mission {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--color-muted);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.briefing-quote {
  margin: 0;
  padding: 0;
}

.briefing-quote p {
  font-size: 16px;
  font-style: italic;
  line-height: 1.6;
  color: var(--color-text-primary);
  opacity: 0.45;
  margin: 0 0 6px;
}

.briefing-quote cite {
  font-size: 11px;
  font-style: normal;
  letter-spacing: 0.05em;
  color: var(--color-muted);
  opacity: 0.4;
}

.briefing-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.briefing-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--color-muted);
  opacity: 0.3;
}

.briefing-hint {
  font-size: 11px;
  color: var(--color-muted);
  opacity: 0.35;
  letter-spacing: 0.05em;
}

/* Fade-out transition when first message is sent */
.briefing-fade-leave-active {
  transition: opacity 0.4s ease, transform 0.4s ease;
}
.briefing-fade-leave-to {
  opacity: 0;
  transform: translateY(-12px);
}

/* Fade-in on mount */
.briefing-fade-enter-active {
  transition: opacity 0.5s ease 0.1s, transform 0.5s ease 0.1s;
}
.briefing-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
</style>
