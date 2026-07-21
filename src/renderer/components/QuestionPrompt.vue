<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PhX } from '@phosphor-icons/vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
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
      <BondText :id="titleId" size="sm" weight="medium">{{ question }}</BondText>
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
          <BondText size="sm" weight="medium">{{ option.label }}</BondText>
          <BondText v-if="option.description" size="xs" color="muted" class="option-description">{{ option.description }}</BondText>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.question-prompt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.question-prompt:focus {
  outline: none;
}
.question-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.question-header > :first-child {
  min-width: 0;
}
.question-options {
  display: flex;
  flex-direction: column;
}
.question-option {
  display: flex;
  width: 100%;
  min-height: 40px;
  padding: 9px 0;
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
  gap: 1px;
  min-width: 0;
}

@media (max-width: 700px) {
  .question-prompt {
    gap: 2px;
    padding: 8px 12px;
    border-right: 0;
    border-left: 0;
    border-radius: 0;
  }
  .option-description {
    display: none;
  }
}
</style>
