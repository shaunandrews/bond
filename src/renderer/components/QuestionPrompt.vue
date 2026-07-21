<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PhQuestion, PhX } from '@phosphor-icons/vue'
import BondButton from './BondButton.vue'
import type { QuestionAnswer, QuestionOption } from '../../shared/questions'

const props = defineProps<{
  questionId: string
  question: string
  header?: string
  options: QuestionOption[]
}>()

const emit = defineEmits<{
  answer: [questionId: string, answer: QuestionAnswer]
}>()

const titleId = computed(() => `question-${props.questionId}`)
const rootEl = ref<HTMLElement | null>(null)
function choose(option: QuestionOption) {
  emit('answer', props.questionId, { kind: 'option', optionId: option.id, label: option.label, number: option.number })
}

function dismiss() {
  emit('answer', props.questionId, { kind: 'cancelled' })
}

function onKey(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Escape') dismiss()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  rootEl.value?.focus()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="question-prompt" role="group" :aria-labelledby="titleId" tabindex="-1">
    <div class="question-header">
      <span class="question-heading">
        <PhQuestion :size="16" weight="bold" aria-hidden="true" />
        <span :id="titleId" class="question-title">{{ question }}</span>
      </span>
      <BondButton variant="ghost" size="sm" icon aria-label="Dismiss question" @click="dismiss" v-tooltip="'Dismiss'">
        <PhX :size="14" />
      </BondButton>
    </div>

    <div class="question-options">
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        class="question-option"
        :aria-label="option.description ? `${option.label}. ${option.description}` : option.label"
        @click="choose(option)"
      >
        <span class="option-copy">
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.description" class="option-description">{{ option.description }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.question-prompt {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.question-prompt:focus {
  outline: none;
}
.question-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px;
}
.question-heading {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-width: 0;
  color: var(--color-accent);
}
.question-title {
  min-width: 0;
  color: var(--color-text-primary);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.question-options {
  display: flex;
  flex-direction: column;
}
.question-option {
  display: flex;
  width: 100%;
  min-height: 44px;
  padding: 12px;
  border: 0;
  border-top: 1px solid var(--color-border);
  border-radius: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.question-option:hover,
.question-option:focus-visible,
.question-option:active {
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}
.option-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.option-label {
  color: var(--color-text-primary);
  /* Match the composer: ordinary 16px body text, not mini card headings. */
  font-size: 16px;
  font-weight: 400;
  line-height: 1.35;
}
.option-description {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.35;
}

@media (max-width: 700px) {
  .question-prompt {
    border-right: 0;
    border-left: 0;
    border-radius: 0;
  }
  .question-header {
    padding: 12px 16px 8px;
  }
  .question-option {
    padding: 12px 16px;
  }
}
</style>
