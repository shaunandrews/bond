<script setup lang="ts">
import { ref } from 'vue'
import ChatHeader from './ChatHeader.vue'
import ChatInput from './ChatInput.vue'
import MessageBubble from './MessageBubble.vue'
import ThinkingIndicator from './ThinkingIndicator.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import type { Message } from '../types/message'

const emit = defineEmits<{ close: [] }>()

const expandedSections = ref<Set<string>>(new Set(['ChatHeader']))

function toggle(name: string) {
  if (expandedSections.value.has(name)) {
    expandedSections.value.delete(name)
  } else {
    expandedSections.value.add(name)
  }
}

// Sample data for previews
const sampleMessages: Record<string, Message> = {
  user: { id: '1', role: 'user', text: 'How do I center a div in CSS?' },
  bond: { id: '2', role: 'bond', text: 'There are several ways to **center a div** in CSS:\n\n1. **Flexbox** — the modern go-to\n2. **Grid** — equally good\n3. **Margin auto** — for horizontal centering\n\n```css\n.parent {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n```', streaming: false },
  bondStreaming: { id: '3', role: 'bond', text: 'Let me think about that...', streaming: true },
  tool: { id: '4', role: 'meta', kind: 'tool', name: 'read_file', summary: 'Read src/app.css' },
  error: { id: '5', role: 'meta', kind: 'error', text: 'Connection lost. Please try again.' },
  system: { id: '6', role: 'meta', kind: 'system', text: 'Session started' },
}

const components = [
  {
    name: 'ChatHeader',
    file: 'components/ChatHeader.vue',
    description: 'App header bar with title. Pure presentational — no props or events.',
    props: [],
    events: [],
  },
  {
    name: 'ChatInput',
    file: 'components/ChatInput.vue',
    description: 'Textarea with Send/Stop buttons. Handles Enter-to-submit, auto-focuses after response.',
    props: [
      { name: 'busy', type: 'boolean', description: 'When true, disables input and enables Stop button' },
    ],
    events: [
      { name: 'submit', payload: 'text: string', description: 'Fired when user sends a message' },
      { name: 'cancel', payload: '(none)', description: 'Fired when user clicks Stop' },
    ],
  },
  {
    name: 'MessageBubble',
    file: 'components/MessageBubble.vue',
    description: 'Renders all message variants: user, bond, tool, error, system. Delegates markdown rendering to MarkdownMessage.',
    props: [
      { name: 'msg', type: 'Message', description: 'Union type — role determines which variant renders' },
    ],
    events: [],
  },
  {
    name: 'MarkdownMessage',
    file: 'components/MarkdownMessage.vue',
    description: 'Renders markdown text with syntax highlighting and copy-to-clipboard code blocks.',
    props: [
      { name: 'text', type: 'string', description: 'Raw markdown string to render' },
      { name: 'streaming', type: 'boolean', description: 'Whether the message is still streaming (currently unused visually but available)' },
    ],
    events: [],
  },
  {
    name: 'ThinkingIndicator',
    file: 'components/ThinkingIndicator.vue',
    description: 'Animated "Bond is working..." with blinking dots. Pure presentational — no props or events.',
    props: [],
    events: [],
  },
  {
    name: 'SessionSidebar',
    file: 'components/SessionSidebar.vue',
    description: 'Left sidebar with session list, create/archive/delete controls, and date formatting.',
    props: [
      { name: 'sessions', type: 'Session[]', description: 'Active sessions to display' },
      { name: 'archivedSessions', type: 'Session[]', description: 'Archived sessions (shown when toggled)' },
      { name: 'activeSessionId', type: 'string | null', description: 'Currently selected session ID' },
      { name: 'showArchived', type: 'boolean', description: 'Whether the archived section is expanded' },
    ],
    events: [
      { name: 'select', payload: 'id: string', description: 'Session clicked' },
      { name: 'create', payload: '(none)', description: 'New chat button clicked' },
      { name: 'archive', payload: 'id: string', description: 'Archive a session' },
      { name: 'unarchive', payload: 'id: string', description: 'Unarchive a session' },
      { name: 'remove', payload: 'id: string', description: 'Delete a session' },
      { name: 'toggleArchived', payload: '(none)', description: 'Toggle archived section visibility' },
    ],
  },
]
</script>

<template>
  <div class="dev-components">
    <header class="dev-header">
      <div>
        <h1 class="text-xl font-semibold tracking-tight m-0">Components</h1>
        <p class="text-sm text-muted mt-0.5">{{ components.length }} components</p>
      </div>
      <button type="button" class="dev-close" @click="emit('close')" title="Back to chat">
        &times;
      </button>
    </header>

    <div class="dev-list">
      <div v-for="comp in components" :key="comp.name" class="dev-card">
        <button type="button" class="dev-card-header" @click="toggle(comp.name)">
          <div>
            <span class="dev-card-name">{{ comp.name }}</span>
            <span class="dev-card-file">{{ comp.file }}</span>
          </div>
          <span class="dev-card-chevron" :class="{ open: expandedSections.has(comp.name) }">&#9654;</span>
        </button>

        <div v-if="expandedSections.has(comp.name)" class="dev-card-body">
          <p class="text-sm text-muted mb-3">{{ comp.description }}</p>

          <!-- Props table -->
          <div v-if="comp.props.length" class="mb-3">
            <h3 class="dev-section-title">Props</h3>
            <table class="dev-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in comp.props" :key="p.name">
                  <td><code>{{ p.name }}</code></td>
                  <td><code>{{ p.type }}</code></td>
                  <td>{{ p.description }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Events table -->
          <div v-if="comp.events.length" class="mb-3">
            <h3 class="dev-section-title">Events</h3>
            <table class="dev-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Payload</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in comp.events" :key="e.name">
                  <td><code>{{ e.name }}</code></td>
                  <td><code>{{ e.payload }}</code></td>
                  <td>{{ e.description }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Live preview -->
          <div class="dev-preview">
            <h3 class="dev-section-title">Preview</h3>
            <div class="dev-preview-area">
              <!-- ChatHeader -->
              <ChatHeader v-if="comp.name === 'ChatHeader'" />

              <!-- ChatInput -->
              <template v-if="comp.name === 'ChatInput'">
                <div class="dev-preview-row">
                  <span class="dev-preview-label">idle</span>
                  <ChatInput :busy="false" @submit="() => {}" @cancel="() => {}" />
                </div>
                <div class="dev-preview-row">
                  <span class="dev-preview-label">busy</span>
                  <ChatInput :busy="true" @submit="() => {}" @cancel="() => {}" />
                </div>
              </template>

              <!-- MessageBubble -->
              <template v-if="comp.name === 'MessageBubble'">
                <div class="dev-preview-messages">
                  <span class="dev-preview-label">user</span>
                  <MessageBubble :msg="sampleMessages.user" />
                  <span class="dev-preview-label">bond</span>
                  <MessageBubble :msg="sampleMessages.bond" />
                  <span class="dev-preview-label">bond (streaming)</span>
                  <MessageBubble :msg="sampleMessages.bondStreaming" />
                  <span class="dev-preview-label">tool</span>
                  <MessageBubble :msg="sampleMessages.tool" />
                  <span class="dev-preview-label">error</span>
                  <MessageBubble :msg="sampleMessages.error" />
                  <span class="dev-preview-label">system</span>
                  <MessageBubble :msg="sampleMessages.system" />
                </div>
              </template>

              <!-- MarkdownMessage -->
              <template v-if="comp.name === 'MarkdownMessage'">
                <MarkdownMessage
                  :text="sampleMessages.bond.role === 'bond' ? sampleMessages.bond.text : ''"
                  :streaming="false"
                />
              </template>

              <!-- ThinkingIndicator -->
              <ThinkingIndicator v-if="comp.name === 'ThinkingIndicator'" />

              <!-- SessionSidebar — just note, too complex for inline preview -->
              <p v-if="comp.name === 'SessionSidebar'" class="text-sm text-muted italic">
                Visible in the main app layout — see sidebar on the left.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dev-components {
  flex: 1;
  min-width: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dev-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2.75rem 1.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  -webkit-app-region: drag;
}
.dev-header * {
  -webkit-app-region: no-drag;
}

.dev-close {
  all: unset;
  cursor: pointer;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 1.25rem;
  color: var(--color-muted);
  transition: background 0.15s, color 0.15s;
}
.dev-close:hover {
  background: color-mix(in srgb, var(--color-border) 60%, transparent);
  color: var(--color-text-primary);
}

.dev-list {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.5rem 2rem;
}

.dev-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 0.75rem;
}

.dev-card-header {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  transition: background 0.12s;
}
.dev-card-header:hover {
  background: color-mix(in srgb, var(--color-border) 25%, transparent);
}

.dev-card-name {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.dev-card-file {
  font-size: 0.75rem;
  color: var(--color-muted);
  margin-left: 0.75rem;
  font-family: ui-monospace, monospace;
}

.dev-card-chevron {
  font-size: 0.65rem;
  color: var(--color-muted);
  transition: transform 0.15s;
}
.dev-card-chevron.open {
  transform: rotate(90deg);
}

.dev-card-body {
  padding: 0 1rem 1rem;
  border-top: 1px solid var(--color-border);
  padding-top: 0.75rem;
}

.dev-section-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
  margin: 0 0 0.5rem;
}

.dev-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.dev-table th {
  text-align: left;
  font-weight: 600;
  color: var(--color-muted);
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
}
.dev-table td {
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
}
.dev-table code {
  background: color-mix(in srgb, var(--color-border) 40%, transparent);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.85em;
  font-family: ui-monospace, monospace;
}

.dev-preview {
  margin-top: 0.25rem;
}

.dev-preview-area {
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  padding: 1rem;
  background: var(--color-bg);
}

.dev-preview-row {
  margin-bottom: 1rem;
}
.dev-preview-row:last-child {
  margin-bottom: 0;
}

.dev-preview-label {
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
  margin-bottom: 0.375rem;
}

.dev-preview-messages {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
