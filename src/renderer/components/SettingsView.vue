<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { PhTrash, PhPlus } from '@phosphor-icons/vue'
import { useAccentColor } from '../composables/useAccentColor'
import { MODEL_IDS, type ModelId } from '../../shared/models'
import BondSelect from './BondSelect.vue'
import BondButton from './BondButton.vue'

interface SkillInfo { name: string; description: string; argumentHint: string }

const emit = defineEmits<{
  createSkill: [description: string]
}>()

const soul = ref('')
const originalSoul = ref('')
const soulDirty = computed(() => soul.value !== originalSoul.value)
const defaultModel = ref<ModelId>('sonnet')
const skills = ref<SkillInfo[]>([])
const showNewSkillModal = ref(false)
const newSkillDescription = ref('')
const newSkillInputEl = ref<HTMLTextAreaElement | null>(null)

const { accent, defaultAccent, setAccent, reset: resetAccent } = useAccentColor()

const windowOpacity = ref(1)

async function loadWindowOpacity() {
  windowOpacity.value = await window.bond.getWindowOpacity()
}

function handleOpacityInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value)
  windowOpacity.value = val
  window.bond.saveWindowOpacity(val)
}

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
  const [s, m, sk] = await Promise.all([
    window.bond.getSoul(),
    window.bond.getModel(),
    window.bond.listSkills(),
    loadWindowOpacity()
  ])
  soul.value = s
  originalSoul.value = s
  defaultModel.value = m as ModelId
  skills.value = sk
})

async function handleRemoveSkill(name: string) {
  await window.bond.removeSkill(name)
  skills.value = skills.value.filter(s => s.name !== name)
}

function openNewSkillModal() {
  newSkillDescription.value = ''
  showNewSkillModal.value = true
  nextTick(() => newSkillInputEl.value?.focus())
}

function submitNewSkill() {
  const desc = newSkillDescription.value.trim()
  if (!desc) return
  showNewSkillModal.value = false
  emit('createSkill', desc)
}

function handleModalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    showNewSkillModal.value = false
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submitNewSkill()
  }
}

async function handleSave() {
  await window.bond.saveSoul(soul.value)
  originalSoul.value = soul.value
}

function handleDiscard() {
  soul.value = originalSoul.value
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
            v-tooltip="preset.label"
            @click="setAccent(preset.hex)"
          />
          <label class="color-swatch custom-swatch" :style="{ '--swatch-color': accent }" v-tooltip="'Custom color'">
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
          <h2 class="text-sm font-semibold text-text-primary">Transparency</h2>
        </div>

        <div class="opacity-slider-row">
          <span class="text-xs text-muted">More</span>
          <input
            type="range"
            class="opacity-slider"
            min="0"
            max="1"
            step="0.01"
            :value="windowOpacity"
            @input="handleOpacityInput"
          />
          <span class="text-xs text-muted">Less</span>
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
        <div v-if="soulDirty" class="soul-actions">
          <BondButton variant="ghost" size="sm" @click="handleDiscard">Discard</BondButton>
          <BondButton variant="primary" size="sm" @click="handleSave">Save</BondButton>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-header">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-text-primary">Skills</h2>
            <BondButton variant="ghost" size="sm" @click="openNewSkillModal">
              <PhPlus :size="14" weight="bold" />
              New skill
            </BondButton>
          </div>
          <p class="text-xs text-muted mt-1">
            Skills extend what Bond can do. Type <code class="text-accent">/skill-name</code> in chat to invoke one.
          </p>
        </div>

        <div v-if="skills.length" class="skill-list">
          <div v-for="skill in skills" :key="skill.name" class="skill-row">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-sm font-medium text-text-primary">/{{ skill.name }}</span>
              <span class="text-xs text-muted truncate">{{ skill.description }}</span>
            </div>
            <button
              type="button"
              class="skill-remove-btn"
              v-tooltip="'Remove skill'"
              @click="handleRemoveSkill(skill.name)"
            >
              <PhTrash :size="14" weight="regular" />
            </button>
          </div>
        </div>
        <p v-else class="text-xs text-muted">
          No skills installed yet.
        </p>
      </section>

      <!-- New Skill Modal -->
      <Teleport to="body">
        <Transition name="modal">
          <div v-if="showNewSkillModal" class="modal-backdrop" @mousedown.self="showNewSkillModal = false">
            <div class="modal-content" @keydown="handleModalKeyDown">
              <h3 class="text-sm font-semibold text-text-primary">New Skill</h3>
              <p class="text-xs text-muted mt-1">Describe what this skill should do. Bond will create it for you.</p>
              <textarea
                ref="newSkillInputEl"
                v-model="newSkillDescription"
                class="modal-textarea"
                placeholder="e.g. Summarize a webpage URL into bullet points"
                :spellcheck="false"
                rows="3"
              />
              <div class="flex justify-end gap-2 mt-3">
                <BondButton variant="secondary" size="sm" @click="showNewSkillModal = false">Cancel</BondButton>
                <BondButton variant="primary" size="sm" @click="submitNewSkill" :disabled="!newSkillDescription.trim()">Create</BondButton>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
  </main>
</template>

<style scoped>
.settings-content {
  display: flex;
  flex-direction: column;
  gap: 2rem;
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

.soul-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.section-footer {
  display: flex;
  justify-content: flex-start;
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

.opacity-slider-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.opacity-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: var(--color-border);
  outline: none;
  cursor: pointer;
}
.opacity-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-accent);
  border: 2px solid var(--color-surface);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: transform var(--transition-fast);
}
.opacity-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
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

.skill-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.skill-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 0.75rem;
}
.skill-row + .skill-row {
  border-top: 1px solid var(--color-border);
}

.skill-remove-btn {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  color: var(--color-muted);
  transition: color var(--transition-fast), background var(--transition-fast);
}
.skill-remove-btn:hover {
  color: var(--color-err);
  background: var(--color-tint);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay);
  backdrop-filter: blur(4px);
}

.modal-content {
  width: 420px;
  max-width: 90vw;
  padding: 1.25rem;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
}

.modal-textarea {
  width: 100%;
  margin-top: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 0.875rem;
  resize: none;
  outline: none;
  transition: border-color var(--transition-fast);
}
.modal-textarea::placeholder {
  color: var(--color-muted);
}
.modal-textarea:focus {
  border-color: var(--color-accent);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--transition-base);
}
.modal-enter-active .modal-content,
.modal-leave-active .modal-content {
  transition: transform var(--transition-base);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-content {
  transform: scale(0.96);
}
.modal-leave-to .modal-content {
  transform: scale(0.96);
}
</style>
