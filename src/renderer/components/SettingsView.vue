<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAccentColor } from '../composables/useAccentColor'
import { MODEL_IDS, type ModelId } from '../../shared/models'
import BondSelect from './BondSelect.vue'

const soul = ref('')
const saved = ref(false)
const defaultModel = ref<ModelId>('sonnet')
let saveTimeout: ReturnType<typeof setTimeout> | undefined

const { accent, defaultAccent, setAccent, reset: resetAccent } = useAccentColor()

const modelOptions = MODEL_IDS.map(id => ({
  value: id,
  label: id.charAt(0).toUpperCase() + id.slice(1)
}))

const presetColors = [
  { hex: '#7a5c3b', label: 'Warm Brown' },
  { hex: '#3b6b7a', label: 'Teal' },
  { hex: '#5c3b7a', label: 'Purple' },
  { hex: '#3b7a5c', label: 'Forest' },
  { hex: '#7a3b3b', label: 'Brick' },
  { hex: '#3b5c7a', label: 'Steel' },
  { hex: '#7a6b3b', label: 'Olive' },
  { hex: '#7a3b6b', label: 'Berry' },
]

onMounted(async () => {
  const [s, m] = await Promise.all([window.bond.getSoul(), window.bond.getModel()])
  soul.value = s
  defaultModel.value = m as ModelId
})

async function handleSave() {
  await window.bond.saveSoul(soul.value)
  saved.value = true
  clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => { saved.value = false }, 2000)
}

function handleColorInput(e: Event) {
  const val = (e.target as HTMLInputElement).value
  setAccent(val)
}

function handleModelChange(model: string) {
  defaultModel.value = model as ModelId
  window.bond.setModel(model)
}
</script>

<template>
  <main class="settings-content app-main px-6">
      <section class="settings-section">
        <div class="section-header">
          <h2 class="text-sm font-semibold text-text-primary">Accent Color</h2>
          <p class="text-xs text-muted mt-1">
            Pick a color to set the mood. The entire interface adapts to your choice.
          </p>
        </div>

        <div class="color-picker-row">
          <button
            v-for="preset in presetColors"
            :key="preset.hex"
            type="button"
            :class="['color-swatch', { active: accent === preset.hex }]"
            :style="{ '--swatch-color': preset.hex }"
            :title="preset.label"
            @click="setAccent(preset.hex)"
          />
          <label class="color-swatch custom-swatch" :style="{ '--swatch-color': accent }" title="Custom color">
            <input
              type="color"
              :value="accent"
              @input="handleColorInput"
              class="color-input-hidden"
            />
          </label>
        </div>

        <div v-if="accent !== defaultAccent" class="section-footer">
          <button type="button" class="reset-btn" @click="resetAccent">Reset to default</button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-header">
          <h2 class="text-sm font-semibold text-text-primary">Default Model</h2>
          <p class="text-xs text-muted mt-1">
            The model used for new chats. You can still switch models per-conversation in the chat input.
          </p>
        </div>

        <BondSelect
          :modelValue="defaultModel"
          :options="modelOptions"
          @update:modelValue="handleModelChange"
        />
      </section>

      <section class="settings-section">
        <div class="section-header">
          <h2 class="text-sm font-semibold text-text-primary">Personality</h2>
          <p class="text-xs text-muted mt-1">
            Shape how Bond talks and thinks. This is included in every conversation as part of its system prompt.
          </p>
        </div>

        <textarea
          v-model="soul"
          class="soul-editor"
          placeholder="e.g. You speak casually and use dry humor. Keep answers short unless asked to elaborate. You're encouraging but honest — don't sugarcoat things."
          spellcheck="false"
        />

        <div class="section-footer">
          <button
            type="button"
            class="save-btn"
            @click="handleSave"
          >
            {{ saved ? 'Saved' : 'Save' }}
          </button>
        </div>
      </section>
  </main>
</template>

<style scoped>
.settings-content {
  padding-bottom: 2rem;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-header {
  display: flex;
  flex-direction: column;
}

.soul-editor {
  width: 100%;
  min-height: 200px;
  padding: 0.75rem;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  line-height: 1.6;
  resize: vertical;
  box-sizing: border-box;
  outline: none;
  transition: border-color var(--transition-base);
}
.soul-editor::placeholder {
  color: var(--color-muted);
  opacity: 0.6;
}
.soul-editor:focus {
  border-color: var(--color-accent);
}

.section-footer {
  display: flex;
  justify-content: flex-start;
}

.save-btn {
  all: unset;
  cursor: pointer;
  padding: 0.4rem 1rem;
  border-radius: var(--radius-md);
  font-size: 0.85rem;
  font-weight: 500;
  background: var(--color-accent);
  color: #fff;
  transition: opacity var(--transition-base);
}
.save-btn:hover {
  opacity: 0.85;
}

.color-picker-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.color-swatch {
  all: unset;
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--swatch-color);
  border: 2px solid transparent;
  transition: border-color var(--transition-base), transform var(--transition-base);
  position: relative;
}
.color-swatch:hover {
  transform: scale(1.1);
}
.color-swatch.active {
  border-color: var(--color-text-primary);
}

.custom-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: conic-gradient(
    from 0deg,
    hsl(0, 70%, 55%),
    hsl(60, 70%, 55%),
    hsl(120, 70%, 55%),
    hsl(180, 70%, 55%),
    hsl(240, 70%, 55%),
    hsl(300, 70%, 55%),
    hsl(360, 70%, 55%)
  );
}

.color-input-hidden {
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  position: absolute;
  inset: 0;
}

.reset-btn {
  all: unset;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--color-muted);
  transition: color var(--transition-base);
}
.reset-btn:hover {
  color: var(--color-text-primary);
}
</style>
