<script setup lang="ts">
import { ref, onMounted } from 'vue'

const soul = ref('')
const saved = ref(false)
let saveTimeout: ReturnType<typeof setTimeout> | undefined

onMounted(async () => {
  soul.value = await window.bond.getSoul()
})

async function handleSave() {
  await window.bond.saveSoul(soul.value)
  saved.value = true
  clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => { saved.value = false }, 2000)
}
</script>

<template>
  <main class="settings-content app-main px-6">
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
</style>
