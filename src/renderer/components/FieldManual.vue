<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import {
  PhKeyboard,
  PhLightning,
  PhLightbulb,
  PhChatCircle,
  PhFolders,
  PhCheckSquare,
  PhBookOpen,
  PhSquaresFour,
  PhImages,
  PhEye,
  PhGlobe,
  PhRobot,
  PhWrench,
} from '@phosphor-icons/vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

watch(() => props.open, (val) => {
  if (val) {
    document.addEventListener('keydown', onKeyDown, { capture: true })
  } else {
    document.removeEventListener('keydown', onKeyDown, { capture: true })
  }
})

onMounted(() => {
  if (props.open) {
    document.addEventListener('keydown', onKeyDown, { capture: true })
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown, { capture: true })
})

const shortcuts = [
  { key: '⌘B', action: 'Toggle sidebar' },
  { key: '⌘⇧B', action: 'Toggle right panel' },
  { key: '⌘N', action: 'New chat' },
  { key: '⌘,', action: 'Settings' },
  { key: '⌘⇧K', action: 'Browser panel' },
  { key: '⌘T', action: 'New browser tab (when browser panel open)' },
  { key: '⌘L', action: 'Focus browser URL bar' },
  { key: 'Escape', action: 'Cancel response' },
  { key: '⌘/', action: 'Open this Field Manual' },
]

const capabilities = [
  {
    icon: PhChatCircle,
    name: 'Chat',
    description: 'Talk naturally. Attach images (⌘V paste or drag). Ask Bond to read, write, and edit files, run shell commands, or search the web. Use edit modes (full/readonly/scoped) to control file access.',
  },
  {
    icon: PhFolders,
    name: 'Projects',
    description: 'Organize work with goals, deadlines, and resources (files, folders, links). Link chats and todos to projects so Bond has the right context. Create from the sidebar or ask Bond.',
  },
  {
    icon: PhCheckSquare,
    name: 'Todos',
    description: 'Task tracking with groups, notes, and project links. Bond can create and complete todos during conversations. Manage in the sidebar panel or conversationally.',
  },
  {
    icon: PhBookOpen,
    name: 'Journal',
    description: 'Persistent entries for reflections, decisions, and notes. Both you and Bond can write. Link entries to projects. Search across all entries.',
  },
  {
    icon: PhSquaresFour,
    name: 'Collections',
    description: 'Track anything with custom schemas — movies, books, coffee, workouts. Define your own fields. Add items conversationally.',
  },
  {
    icon: PhImages,
    name: 'Media Library',
    description: 'Store and organize images. Bond can download images from the web. All images are searchable by filename.',
  },
  {
    icon: PhEye,
    name: 'Sense',
    description: 'Ambient screen awareness. Bond can see what you\'re working on, summarize your day, recall something you saw earlier, or break down app usage.',
  },
  {
    icon: PhGlobe,
    name: 'Browser',
    description: 'Built-in browser in the right panel. Bond can open URLs, read page content, take screenshots, and execute JavaScript.',
  },
  {
    icon: PhRobot,
    name: 'Operatives',
    description: 'Autonomous coding agents that work in the background. Each gets its own context window. Use worktrees for git isolation when running multiple operatives.',
  },
  {
    icon: PhWrench,
    name: 'Skills',
    description: 'Custom commands invoked with /skill-name. Extend Bond\'s behavior for your specific workflows. Create via settings or ask Bond to build one.',
  },
]

const tips = [
  'Drag files into chat for context (not just images — code, PDFs, text)',
  'Bond remembers context within a session — refer back freely',
  'Link chats to projects for focused, goal-oriented work',
  'Use /skill-name to invoke custom skills',
  'Use the journal to preserve decisions and summaries across sessions',
  'Operatives can work in parallel — spin up multiple for different tasks',
]
</script>

<template>
  <Transition name="field-manual">
    <div v-if="open" class="field-manual-backdrop" @click.self="emit('close')">
      <div class="field-manual-card">
        <!-- Header -->
        <div class="field-manual-header">
          <div class="field-manual-stamp">CLASSIFIED</div>
          <h1 class="field-manual-title">FIELD MANUAL</h1>
          <div class="field-manual-subtitle">Agent Reference Dossier</div>
        </div>

        <!-- Keyboard Shortcuts -->
        <section class="field-manual-section">
          <h2 class="field-manual-section-title">
            <PhKeyboard :size="18" weight="duotone" />
            Keyboard Shortcuts
          </h2>
          <div class="field-manual-shortcuts">
            <div v-for="s in shortcuts" :key="s.key" class="field-manual-shortcut">
              <kbd class="field-manual-kbd">{{ s.key }}</kbd>
              <span class="field-manual-shortcut-action">{{ s.action }}</span>
            </div>
          </div>
        </section>

        <!-- Capabilities -->
        <section class="field-manual-section">
          <h2 class="field-manual-section-title">
            <PhLightning :size="18" weight="duotone" />
            Capabilities
          </h2>
          <div class="field-manual-capabilities">
            <div v-for="cap in capabilities" :key="cap.name" class="field-manual-capability">
              <div class="field-manual-capability-header">
                <component :is="cap.icon" :size="16" weight="duotone" />
                <span class="field-manual-capability-name">{{ cap.name }}</span>
              </div>
              <p class="field-manual-capability-desc">{{ cap.description }}</p>
            </div>
          </div>
        </section>

        <!-- Pro Tips -->
        <section class="field-manual-section">
          <h2 class="field-manual-section-title">
            <PhLightbulb :size="18" weight="duotone" />
            Pro Tips
          </h2>
          <ul class="field-manual-tips">
            <li v-for="tip in tips" :key="tip" class="field-manual-tip">{{ tip }}</li>
          </ul>
        </section>

        <div class="field-manual-footer">
          <kbd class="field-manual-kbd">Esc</kbd> to close &middot; <kbd class="field-manual-kbd">⌘/</kbd> to toggle
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.field-manual-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-heavy, rgba(0, 0, 0, 0.8));
  padding: 40px 20px;
  overflow-y: auto;
}

.field-manual-card {
  position: relative;
  width: 100%;
  max-width: 720px;
  max-height: 100%;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  padding: 40px;

  /* Dossier dot grid background */
  background-image: radial-gradient(circle, var(--color-border) 0.5px, transparent 0.5px);
  background-size: 16px 16px;
  background-position: 8px 8px;

  /* Hide scrollbar */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.field-manual-card::-webkit-scrollbar {
  display: none;
}

/* Header */
.field-manual-header {
  text-align: center;
  margin-bottom: 32px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--color-border);
}

.field-manual-stamp {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3em;
  color: var(--color-err);
  opacity: 0.7;
  border: 1.5px solid var(--color-err);
  padding: 2px 12px;
  border-radius: 2px;
  transform: rotate(-2deg);
  margin-bottom: 12px;
}

.field-manual-title {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.15em;
  color: var(--color-text-primary);
  margin: 0;
  font-family: var(--font-mono);
}

.field-manual-subtitle {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--color-muted);
  margin-top: 6px;
  text-transform: uppercase;
}

/* Sections */
.field-manual-section {
  margin-bottom: 28px;
}

.field-manual-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-primary);
  margin: 0 0 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
}

/* Keyboard Shortcuts */
.field-manual-shortcuts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 24px;
}

.field-manual-shortcut {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.field-manual-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  padding: 2px 7px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-primary);
  background: var(--color-tint);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.field-manual-shortcut-action {
  font-size: 13px;
  color: var(--color-muted);
}

/* Capabilities */
.field-manual-capabilities {
  display: grid;
  gap: 12px;
}

.field-manual-capability {
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 60%, transparent);
}

.field-manual-capability-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  color: var(--color-text-primary);
}

.field-manual-capability-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.field-manual-capability-desc {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--color-muted);
  margin: 0;
}

/* Pro Tips */
.field-manual-tips {
  margin: 0;
  padding: 0;
  list-style: none;
}

.field-manual-tip {
  position: relative;
  padding: 6px 0 6px 18px;
  font-size: 13px;
  color: var(--color-muted);
  line-height: 1.5;
}

.field-manual-tip::before {
  content: '›';
  position: absolute;
  left: 0;
  color: var(--color-accent);
  font-weight: 700;
  font-size: 15px;
}

/* Footer */
.field-manual-footer {
  text-align: center;
  font-size: 11px;
  color: var(--color-muted);
  opacity: 0.6;
  padding-top: 20px;
  border-top: 1px solid var(--color-border);
  margin-top: 8px;
}

/* Transition */
.field-manual-enter-active {
  transition: opacity 0.2s ease;
}
.field-manual-enter-active .field-manual-card {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.field-manual-leave-active {
  transition: opacity 0.15s ease;
}
.field-manual-leave-active .field-manual-card {
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.field-manual-enter-from {
  opacity: 0;
}
.field-manual-enter-from .field-manual-card {
  opacity: 0;
  transform: scale(0.96);
}

.field-manual-leave-to {
  opacity: 0;
}
.field-manual-leave-to .field-manual-card {
  opacity: 0;
  transform: scale(0.96);
}
</style>
