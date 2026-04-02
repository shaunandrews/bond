<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { PhArrowRight, PhArrowLeft, PhGlobe, PhCode, PhPresentation, PhCube } from '@phosphor-icons/vue'
import type { ProjectType } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondTextarea from './BondTextarea.vue'

const emit = defineEmits<{
  submit: [name: string, goal: string, type: ProjectType, deadline: string]
  cancel: []
}>()

type Step = 'name' | 'goal' | 'type'

const step = ref<Step>('name')
const name = ref('')
const goal = ref('')
const type = ref<ProjectType>('generic')
const deadline = ref('')
const nameInputRef = ref<HTMLElement | null>(null)

const steps: Step[] = ['name', 'goal', 'type']

const currentStepIndex = computed(() => steps.indexOf(step.value))
const canAdvance = computed(() => {
  if (step.value === 'name') return name.value.trim().length > 0
  return true
})

const PROJECT_TYPES: { id: ProjectType; label: string; description: string; icon: typeof PhCube }[] = [
  { id: 'wordpress', label: 'WordPress', description: 'WordPress site with WP-specific tools', icon: PhGlobe },
  { id: 'web', label: 'Web', description: 'Web project with dev server and browser preview', icon: PhCode },
  { id: 'presentation', label: 'Presentation', description: 'Slides and presentation content', icon: PhPresentation },
  { id: 'generic', label: 'Generic', description: 'General purpose project', icon: PhCube },
]

function advance() {
  if (!canAdvance.value) return
  const idx = currentStepIndex.value
  if (idx < steps.length - 1) {
    step.value = steps[idx + 1]
  } else {
    emit('submit', name.value.trim(), goal.value.trim(), type.value, deadline.value)
  }
}

function back() {
  const idx = currentStepIndex.value
  if (idx > 0) {
    step.value = steps[idx - 1]
  } else {
    emit('cancel')
  }
}

function selectType(t: ProjectType) {
  type.value = t
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    advance()
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

nextTick(() => {
  nameInputRef.value?.querySelector('input')?.focus()
})
</script>

<template>
  <div class="wizard-overlay" @keydown="onKeyDown">
    <div class="wizard-card">
      <!-- Progress -->
      <div class="wizard-progress">
        <div
          v-for="(s, i) in steps"
          :key="s"
          class="wizard-progress-dot"
          :class="{ active: i === currentStepIndex, done: i < currentStepIndex }"
        />
      </div>

      <!-- Step: Name -->
      <div v-if="step === 'name'" class="wizard-step">
        <BondText as="h2" size="lg" weight="semibold">What's this project called?</BondText>
        <BondInput ref="nameInputRef" :modelValue="name" @update:modelValue="name = $event" placeholder="e.g. Marketing Site Redesign" />
      </div>

      <!-- Step: Goal -->
      <div v-if="step === 'goal'" class="wizard-step">
        <BondText as="h2" size="lg" weight="semibold">What's the goal?</BondText>
        <BondText size="sm" color="muted">Describe what this project is about. Bond will use this to stay focused.</BondText>
        <BondTextarea :modelValue="goal" @update:modelValue="goal = $event" placeholder="e.g. Redesign the company marketing site with a modern look, better performance, and improved mobile experience." :rows="4" />
      </div>

      <!-- Step: Type -->
      <div v-if="step === 'type'" class="wizard-step">
        <BondText as="h2" size="lg" weight="semibold">What kind of project is this?</BondText>
        <div class="type-grid">
          <button
            v-for="t in PROJECT_TYPES"
            :key="t.id"
            class="type-option"
            :class="{ selected: type === t.id }"
            @click="selectType(t.id)"
          >
            <component :is="t.icon" :size="24" weight="bold" />
            <BondText size="sm" weight="medium">{{ t.label }}</BondText>
            <BondText size="xs" color="muted">{{ t.description }}</BondText>
          </button>
        </div>
        <div class="deadline-field">
          <BondText size="sm" color="muted">Deadline (optional)</BondText>
          <input type="date" v-model="deadline" class="deadline-input" />
        </div>
      </div>

      <!-- Actions -->
      <div class="wizard-actions">
        <BondButton variant="ghost" size="sm" @click="back">
          <PhArrowLeft :size="14" weight="bold" />
          {{ currentStepIndex === 0 ? 'Cancel' : 'Back' }}
        </BondButton>
        <BondButton variant="primary" size="sm" :disabled="!canAdvance" @click="advance">
          {{ currentStepIndex === steps.length - 1 ? 'Create project' : 'Next' }}
          <PhArrowRight :size="14" weight="bold" />
        </BondButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg);
}

.wizard-card {
  width: 100%;
  max-width: 480px;
  padding: 2rem;
}

.wizard-progress {
  display: flex;
  gap: 0.375rem;
  justify-content: center;
  margin-bottom: 2rem;
}

.wizard-progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-border);
  transition: background var(--transition-base);
}

.wizard-progress-dot.active {
  background: var(--color-accent, var(--color-text-primary));
}

.wizard-progress-dot.done {
  background: var(--color-ok);
}

.wizard-step {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 200px;
}

.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.type-option {
  all: unset;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  padding: 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  text-align: center;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.type-option:hover {
  background: var(--color-surface);
}

.type-option.selected {
  border-color: var(--color-accent, var(--color-text-primary));
  background: var(--color-surface);
}

.deadline-field {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.deadline-input {
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.3125rem 0.5rem;
  outline: none;
  transition: border-color var(--transition-fast);
  color-scheme: light dark;
}

.deadline-input:focus {
  border-color: var(--color-accent, var(--color-border));
}

.wizard-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 2rem;
}
</style>
