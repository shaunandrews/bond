<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ busy: boolean }>()

const emit = defineEmits<{
  submit: [text: string]
  cancel: []
}>()

const inputEl = ref<HTMLTextAreaElement | null>(null)

function handleSubmit() {
  const text = inputEl.value?.value.trim()
  if (!text) return
  inputEl.value!.value = ''
  emit('submit', text)
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmit()
  }
}
</script>

<template>
  <footer class="app-footer border-t border-border bg-bg">
    <div class="px-5 pt-3 pb-4">
      <textarea
        ref="inputEl"
        rows="3"
        placeholder="Ask Bond something…"
        :spellcheck="false"
        :disabled="busy"
        @keydown="handleKeyDown"
        class="w-full resize-y min-h-[4.5rem] max-h-48 px-3 py-2.5 rounded-lg border border-border bg-surface text-text-primary font-[inherit] text-base focus:outline-2 focus:outline-accent focus:outline-offset-1"
      />
      <div class="flex justify-end gap-2 mt-2">
        <button
          type="button"
          :disabled="!busy"
          @click="emit('cancel')"
          class="text-sm font-semibold px-4 py-1.5 rounded-lg border border-border bg-transparent text-text-primary cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
        >
          Stop
        </button>
        <button
          type="button"
          :disabled="busy"
          @click="handleSubmit()"
          class="text-sm font-semibold px-4 py-1.5 rounded-lg border-transparent bg-accent text-white cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  </footer>
</template>
