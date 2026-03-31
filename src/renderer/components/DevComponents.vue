<script setup lang="ts">
import { ref } from 'vue'
import { PhCaretRight, PhGear, PhPlus, PhTrash } from '@phosphor-icons/vue'
import BondToolbar from './BondToolbar.vue'
import ChatInput from './ChatInput.vue'
import MessageBubble from './MessageBubble.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondTextarea from './BondTextarea.vue'
import BondSelect from './BondSelect.vue'
import BondTab from './BondTab.vue'
import BondPanelGroup from './BondPanelGroup.vue'
import BondPanel from './BondPanel.vue'
import BondPanelHandle from './BondPanelHandle.vue'
import type { Message } from '../types/message'

const expandedSections = ref<Set<string>>(new Set(['BondButton']))

function toggle(name: string) {
  if (expandedSections.value.has(name)) {
    expandedSections.value.delete(name)
  } else {
    expandedSections.value.add(name)
  }
}

// Interactive state for previews
const demoInput = ref('Hello world')
const demoTextarea = ref('Some longer text here...')
const demoSelect = ref('sonnet')
const demoTab = ref('tab1')

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
  // --- Directives ---
  {
    name: 'v-tooltip',
    file: 'directives/tooltip.ts',
    category: 'Directives',
    description: 'Global directive for styled, positioned tooltips. Replaces native title attributes. Supports placement modifiers and skip-delay for rapid hovering.',
    props: [
      { name: 'value', type: "string | { content, placement? }", description: "Tooltip text, or object with content and placement ('top' | 'bottom' | 'left' | 'right')" },
      { name: '.top', type: 'modifier', description: 'Place tooltip above (default)' },
      { name: '.bottom', type: 'modifier', description: 'Place tooltip below' },
      { name: '.left', type: 'modifier', description: 'Place tooltip to the left' },
      { name: '.right', type: 'modifier', description: 'Place tooltip to the right' },
    ],
    events: [],
  },
  // --- Primitives ---
  {
    name: 'BondText',
    file: 'components/BondText.vue',
    category: 'Primitives',
    description: 'Polymorphic text component for all UI text. Renders any HTML element with size, weight, color, alignment, and truncation options.',
    props: [
      { name: 'as', type: 'string', description: "HTML element to render (default: 'span')" },
      { name: 'size', type: "'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl'", description: "Font size (default: 'base')" },
      { name: 'weight', type: "'normal' | 'medium' | 'semibold' | 'bold'", description: "Font weight (default: 'normal')" },
      { name: 'color', type: "'primary' | 'muted' | 'accent' | 'err' | 'ok' | 'inherit'", description: "Text color (default: 'inherit')" },
      { name: 'align', type: "'left' | 'center' | 'right'", description: 'Text alignment' },
      { name: 'truncate', type: 'boolean', description: 'Truncate with ellipsis on overflow' },
      { name: 'mono', type: 'boolean', description: 'Use monospace font' },
    ],
    events: [],
  },
  {
    name: 'BondButton',
    file: 'components/BondButton.vue',
    category: 'Primitives',
    description: 'Button with variant and size options. Supports primary, secondary, ghost, and danger variants.',
    props: [
      { name: 'variant', type: "'primary' | 'secondary' | 'ghost' | 'danger'", description: "Visual style (default: 'secondary')" },
      { name: 'size', type: "'sm' | 'md'", description: "Size (default: 'md')" },
      { name: 'icon', type: 'boolean', description: 'Icon-only mode — square with equal padding' },
      { name: 'disabled', type: 'boolean', description: 'Disables the button' },
    ],
    events: [],
  },
  {
    name: 'BondInput',
    file: 'components/BondInput.vue',
    category: 'Primitives',
    description: 'Text input with v-model support. Styled to match the design system.',
    props: [
      { name: 'modelValue', type: 'string', description: 'Bound value (v-model)' },
      { name: 'placeholder', type: 'string', description: 'Placeholder text' },
      { name: 'type', type: 'string', description: "Input type (default: 'text')" },
      { name: 'disabled', type: 'boolean', description: 'Disables the input' },
    ],
    events: [
      { name: 'update:modelValue', payload: 'value: string', description: 'Fired on input change' },
    ],
  },
  {
    name: 'BondTextarea',
    file: 'components/BondTextarea.vue',
    category: 'Primitives',
    description: 'Multi-line text area with v-model support and resizable height.',
    props: [
      { name: 'modelValue', type: 'string', description: 'Bound value (v-model)' },
      { name: 'placeholder', type: 'string', description: 'Placeholder text' },
      { name: 'rows', type: 'number', description: 'Initial row count (default: 3)' },
      { name: 'disabled', type: 'boolean', description: 'Disables the textarea' },
    ],
    events: [
      { name: 'update:modelValue', payload: 'value: string', description: 'Fired on input change' },
    ],
  },
  {
    name: 'BondSelect',
    file: 'components/BondSelect.vue',
    category: 'Primitives',
    description: 'Dropdown select with custom chevron. Uses BondFlyoutMenu for viewport-aware positioning.',
    props: [
      { name: 'modelValue', type: 'string', description: 'Bound value (v-model)' },
      { name: 'options', type: '{ value, label }[]', description: 'Options to display' },
      { name: 'disabled', type: 'boolean', description: 'Disables the select' },
      { name: 'placement', type: "'top' | 'bottom'", description: 'Menu placement (default: bottom)' },
      { name: 'variant', type: "'default' | 'minimal'", description: 'Minimal removes background/border' },
      { name: 'size', type: "'sm' | 'md'", description: 'Trigger size (default: md)' },
    ],
    events: [
      { name: 'update:modelValue', payload: 'value: string', description: 'Fired on selection change' },
    ],
  },
  {
    name: 'BondFlyoutMenu',
    file: 'components/BondFlyoutMenu.vue',
    category: 'Primitives',
    description: 'Teleported flyout menu. Positions relative to an anchor element, auto-flips at viewport edges, repositions on scroll/resize.',
    props: [
      { name: 'open', type: 'boolean', description: 'Whether the flyout is visible' },
      { name: 'anchor', type: 'HTMLElement | null', description: 'Element to position relative to' },
      { name: 'placement', type: "'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'", description: 'Preferred placement (default: bottom-start)' },
      { name: 'width', type: 'number', description: 'Fixed width in px (optional)' },
      { name: 'padding', type: 'boolean', description: 'Adds 4px inner padding' },
    ],
    events: [
      { name: 'close', payload: '(none)', description: 'Fired on click-outside or Escape' },
    ],
  },
  {
    name: 'BondTab',
    file: 'components/BondTab.vue',
    category: 'Primitives',
    description: 'Segmented tab bar. Use v-model to bind the active tab ID.',
    props: [
      { name: 'tabs', type: '{ id, label }[]', description: 'Tab definitions' },
      { name: 'modelValue', type: 'string', description: 'Active tab ID (v-model)' },
    ],
    events: [
      { name: 'update:modelValue', payload: 'value: string', description: 'Fired when tab is selected' },
    ],
  },
  // --- Layout ---
  {
    name: 'BondPanelGroup',
    file: 'components/BondPanelGroup.vue',
    category: 'Layout',
    description: 'Flex container that manages resizable panel layout. Nest Panels and PanelHandles inside.',
    props: [
      { name: 'direction', type: "'horizontal' | 'vertical'", description: "Layout direction (default: 'horizontal')" },
      { name: 'autoSaveId', type: 'string', description: 'Key for localStorage persistence' },
      { name: 'keyboardStep', type: 'number', description: 'Arrow key step in % (default: 5)' },
    ],
    events: [
      { name: 'layoutChange', payload: 'Record<string, number>', description: 'Fired during resize drag' },
      { name: 'layoutChanged', payload: 'Record<string, number>', description: 'Fired after resize ends' },
    ],
  },
  {
    name: 'BondPanel',
    file: 'components/BondPanel.vue',
    category: 'Layout',
    description: 'Individual resizable panel. Must be a direct child of BondPanelGroup.',
    props: [
      { name: 'id', type: 'string', description: 'Unique panel identifier (required)' },
      { name: 'defaultSize', type: 'number', description: 'Initial size in % (default: 50)' },
      { name: 'minSize', type: 'number', description: 'Minimum size in % (default: 10)' },
      { name: 'maxSize', type: 'number', description: 'Maximum size in % (default: 100)' },
      { name: 'collapsible', type: 'boolean', description: 'Allow collapsing below minSize' },
      { name: 'collapsedSize', type: 'number', description: 'Size when collapsed in % (default: 0)' },
    ],
    events: [],
  },
  {
    name: 'BondPanelHandle',
    file: 'components/BondPanelHandle.vue',
    category: 'Layout',
    description: 'Drag handle between panels. Supports pointer drag, keyboard arrows, and hover/focus states.',
    props: [
      { name: 'id', type: 'string', description: "Handle identifier, format: 'handle-N' (required)" },
      { name: 'disabled', type: 'boolean', description: 'Disable resizing via this handle' },
      { name: 'hitArea', type: 'number', description: 'Hit area width in px (default: 8)' },
    ],
    events: [],
  },
  // --- Composed ---
  {
    name: 'BondToolbar',
    file: 'components/BondToolbar.vue',
    category: 'Layout',
    description: 'Standardized toolbar with true-center middle slot. Grid layout (1fr auto 1fr) with start/middle/end regions.',
    props: [
      { name: 'label', type: 'string', description: 'Accessible aria-label for the toolbar (required)' },
      { name: 'border', type: "'none' | 'bottom'", description: "Edge border (default: 'none')" },
      { name: 'drag', type: 'boolean', description: 'Enable Electron drag region' },
      { name: 'blur', type: 'boolean', description: 'Backdrop blur effect for sticky headers' },
    ],
    events: [],
  },
  {
    name: 'ChatInput',
    file: 'components/ChatInput.vue',
    category: 'Composed',
    description: 'Textarea with Send/Stop buttons and model selector. Handles Enter-to-submit, auto-focuses after response.',
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
    category: 'Composed',
    description: 'Renders all message variants: user, bond, tool, error, system.',
    props: [
      { name: 'msg', type: 'Message', description: 'Union type — role determines which variant renders' },
    ],
    events: [],
  },
  {
    name: 'MarkdownMessage',
    file: 'components/MarkdownMessage.vue',
    category: 'Composed',
    description: 'Renders markdown with syntax highlighting and copy-to-clipboard code blocks.',
    props: [
      { name: 'text', type: 'string', description: 'Raw markdown string' },
      { name: 'streaming', type: 'boolean', description: 'Whether the message is still streaming' },
    ],
    events: [],
  },
  {
    name: 'SessionSidebar',
    file: 'components/SessionSidebar.vue',
    category: 'Composed',
    description: 'Left sidebar with always-open session list, archive flyout, and projects.',
    props: [
      { name: 'sessions', type: 'Session[]', description: 'Active sessions to display' },
      { name: 'archivedSessions', type: 'Session[]', description: 'Archived sessions (shown in flyout)' },
      { name: 'activeSessionId', type: 'string | null', description: 'Currently selected session ID' },
      { name: 'activeView', type: 'AppView', description: 'Current app view' },
      { name: 'generatingTitleId', type: 'string | null', description: 'Session ID currently generating title' },
    ],
    events: [
      { name: 'select', payload: 'id: string', description: 'Session clicked' },
      { name: 'create', payload: '(none)', description: 'New chat button clicked' },
      { name: 'archive', payload: 'id: string', description: 'Archive a session' },
      { name: 'unarchive', payload: 'id: string', description: 'Unarchive a session' },
      { name: 'remove', payload: 'id: string', description: 'Delete a session' },
    ],
  },
]

const categories = ['Directives', 'Primitives', 'Layout', 'Composed'] as const
</script>

<template>
  <main class="dev-list app-main px-6">
      <template v-for="cat in categories" :key="cat">
        <h2 class="dev-category">{{ cat }}</h2>
        <div v-for="comp in components.filter(c => c.category === cat)" :key="comp.name" class="dev-card">
          <button type="button" class="dev-card-header" @click="toggle(comp.name)">
            <div>
              <span class="dev-card-name">{{ comp.name }}</span>
              <span class="dev-card-file">{{ comp.file }}</span>
            </div>
            <PhCaretRight class="dev-card-chevron" :class="{ open: expandedSections.has(comp.name) }" :size="12" weight="bold" />
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

                <!-- v-tooltip -->
                <template v-if="comp.name === 'v-tooltip'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">placements</span>
                    <div class="flex flex-wrap gap-2">
                      <BondButton v-tooltip.top="'Top'" variant="secondary" size="sm">Top</BondButton>
                      <BondButton v-tooltip.bottom="'Bottom'" variant="secondary" size="sm">Bottom</BondButton>
                      <BondButton v-tooltip.left="'Left'" variant="secondary" size="sm">Left</BondButton>
                      <BondButton v-tooltip.right="'Right'" variant="secondary" size="sm">Right</BondButton>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">on icon buttons (hover quickly between them to see skip-delay)</span>
                    <div class="flex flex-wrap gap-2">
                      <BondButton v-tooltip="'Settings'" variant="ghost" size="sm" icon><PhGear :size="16" weight="bold" /></BondButton>
                      <BondButton v-tooltip="'Add'" variant="ghost" size="sm" icon><PhPlus :size="16" weight="bold" /></BondButton>
                      <BondButton v-tooltip="'Delete'" variant="ghost" size="sm" icon><PhTrash :size="16" weight="bold" /></BondButton>
                    </div>
                  </div>
                </template>

                <!-- BondText -->
                <template v-if="comp.name === 'BondText'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">sizes</span>
                    <div class="flex flex-col gap-1">
                      <BondText size="xs" color="primary">xs — Extra small text</BondText>
                      <BondText size="sm" color="primary">sm — Small text</BondText>
                      <BondText size="base" color="primary">base — Base text</BondText>
                      <BondText size="lg" color="primary">lg — Large text</BondText>
                      <BondText size="xl" color="primary">xl — Extra large text</BondText>
                      <BondText size="2xl" color="primary">2xl — Heading size</BondText>
                      <BondText size="3xl" color="primary">3xl — Display size</BondText>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">weights</span>
                    <div class="flex flex-wrap gap-4">
                      <BondText weight="normal" color="primary">Normal</BondText>
                      <BondText weight="medium" color="primary">Medium</BondText>
                      <BondText weight="semibold" color="primary">Semibold</BondText>
                      <BondText weight="bold" color="primary">Bold</BondText>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">colors</span>
                    <div class="flex flex-wrap gap-4">
                      <BondText color="primary">Primary</BondText>
                      <BondText color="muted">Muted</BondText>
                      <BondText color="accent">Accent</BondText>
                      <BondText color="err">Error</BondText>
                      <BondText color="ok">OK</BondText>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">as heading</span>
                    <BondText as="h2" size="2xl" weight="bold" color="primary">Page Title</BondText>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">truncate</span>
                    <div style="max-width: 200px;">
                      <BondText truncate color="primary">This is a very long string that should be truncated with an ellipsis</BondText>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">mono</span>
                    <BondText mono size="sm" color="muted">const x = 42;</BondText>
                  </div>
                </template>

                <!-- BondButton -->
                <template v-if="comp.name === 'BondButton'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">variants</span>
                    <div class="flex flex-wrap gap-2">
                      <BondButton variant="primary">Primary</BondButton>
                      <BondButton variant="secondary">Secondary</BondButton>
                      <BondButton variant="ghost">Ghost</BondButton>
                      <BondButton variant="danger">Danger</BondButton>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">small</span>
                    <div class="flex flex-wrap gap-2">
                      <BondButton variant="primary" size="sm">Primary</BondButton>
                      <BondButton variant="secondary" size="sm">Secondary</BondButton>
                      <BondButton variant="ghost" size="sm">Ghost</BondButton>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">icon</span>
                    <div class="flex flex-wrap gap-2 items-center">
                      <BondButton variant="ghost" size="sm" icon><PhGear :size="16" weight="bold" /></BondButton>
                      <BondButton variant="ghost" size="sm" icon><PhPlus :size="16" weight="bold" /></BondButton>
                      <BondButton variant="ghost" icon><PhGear :size="16" weight="bold" /></BondButton>
                      <BondButton variant="secondary" icon><PhPlus :size="16" weight="bold" /></BondButton>
                      <BondButton variant="danger" icon><PhTrash :size="16" weight="bold" /></BondButton>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">disabled</span>
                    <div class="flex flex-wrap gap-2">
                      <BondButton variant="primary" disabled>Primary</BondButton>
                      <BondButton variant="secondary" disabled>Secondary</BondButton>
                    </div>
                  </div>
                </template>

                <!-- BondInput -->
                <template v-if="comp.name === 'BondInput'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">default</span>
                    <div class="max-w-xs">
                      <BondInput v-model="demoInput" placeholder="Type something..." />
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">disabled</span>
                    <div class="max-w-xs">
                      <BondInput model-value="Can't edit this" disabled />
                    </div>
                  </div>
                </template>

                <!-- BondTextarea -->
                <template v-if="comp.name === 'BondTextarea'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">default</span>
                    <div class="max-w-sm">
                      <BondTextarea v-model="demoTextarea" placeholder="Write something..." :rows="3" />
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">disabled</span>
                    <div class="max-w-sm">
                      <BondTextarea model-value="Read-only content" disabled :rows="2" />
                    </div>
                  </div>
                </template>

                <!-- BondSelect -->
                <template v-if="comp.name === 'BondSelect'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">default</span>
                    <BondSelect
                      v-model="demoSelect"
                      :options="[
                        { value: 'sonnet', label: 'Sonnet' },
                        { value: 'opus', label: 'Opus' },
                        { value: 'haiku', label: 'Haiku' },
                      ]"
                    />
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">disabled</span>
                    <BondSelect
                      model-value="sonnet"
                      disabled
                      :options="[{ value: 'sonnet', label: 'Sonnet' }]"
                    />
                  </div>
                </template>

                <!-- BondTab -->
                <template v-if="comp.name === 'BondTab'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">default</span>
                    <BondTab
                      v-model="demoTab"
                      :tabs="[
                        { id: 'tab1', label: 'Messages' },
                        { id: 'tab2', label: 'Files' },
                        { id: 'tab3', label: 'Settings' },
                      ]"
                    />
                  </div>
                </template>

                <!-- BondToolbar -->
                <template v-if="comp.name === 'BondToolbar'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">with start/middle/end</span>
                    <BondToolbar label="Demo toolbar" border="bottom">
                      <template #start>
                        <BondButton variant="ghost" size="sm" icon><PhGear :size="14" /></BondButton>
                      </template>
                      <template #middle>
                        <BondText size="sm" color="muted">Page title</BondText>
                      </template>
                      <template #end>
                        <BondButton variant="ghost" size="sm" icon><PhPlus :size="14" /></BondButton>
                      </template>
                    </BondToolbar>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">middle only</span>
                    <BondToolbar label="Simple toolbar">
                      <template #middle>
                        <BondText size="sm" color="muted">Centered title</BondText>
                      </template>
                    </BondToolbar>
                  </div>
                </template>

                <!-- ChatInput -->
                <template v-if="comp.name === 'ChatInput'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">idle</span>
                    <ChatInput :busy="false" model="sonnet" @submit="() => {}" @cancel="() => {}" />
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">busy</span>
                    <ChatInput :busy="true" model="sonnet" @submit="() => {}" @cancel="() => {}" />
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


                <!-- BondPanelGroup / BondPanel / BondPanelHandle -->
                <template v-if="comp.name === 'BondPanelGroup'">
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">horizontal (drag the handle)</span>
                    <div style="height: 180px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden;">
                      <BondPanelGroup direction="horizontal">
                        <BondPanel id="demo-h-left" :defaultSize="30" :minSize="15">
                          <div class="dev-panel-content">Left (30%)</div>
                        </BondPanel>
                        <BondPanelHandle id="handle-0" />
                        <BondPanel id="demo-h-right" :defaultSize="70" :minSize="20">
                          <div class="dev-panel-content">Right (70%)</div>
                        </BondPanel>
                      </BondPanelGroup>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">vertical</span>
                    <div style="height: 240px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden;">
                      <BondPanelGroup direction="vertical">
                        <BondPanel id="demo-v-top" :defaultSize="40" :minSize="15">
                          <div class="dev-panel-content">Top (40%)</div>
                        </BondPanel>
                        <BondPanelHandle id="handle-0" />
                        <BondPanel id="demo-v-bottom" :defaultSize="60" :minSize="15">
                          <div class="dev-panel-content">Bottom (60%)</div>
                        </BondPanel>
                      </BondPanelGroup>
                    </div>
                  </div>
                  <div class="dev-preview-row">
                    <span class="dev-preview-label">nested (three-pane IDE layout)</span>
                    <div style="height: 300px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden;">
                      <BondPanelGroup direction="horizontal">
                        <BondPanel id="demo-n-sidebar" :defaultSize="25" :minSize="15" collapsible :collapsedSize="0">
                          <div class="dev-panel-content">Sidebar</div>
                        </BondPanel>
                        <BondPanelHandle id="handle-0" />
                        <BondPanel id="demo-n-main" :defaultSize="75" :minSize="30">
                          <BondPanelGroup direction="vertical">
                            <BondPanel id="demo-n-editor" :defaultSize="65" :minSize="20">
                              <div class="dev-panel-content">Editor</div>
                            </BondPanel>
                            <BondPanelHandle id="handle-0" />
                            <BondPanel id="demo-n-terminal" :defaultSize="35" :minSize="15" collapsible :collapsedSize="0">
                              <div class="dev-panel-content">Terminal</div>
                            </BondPanel>
                          </BondPanelGroup>
                        </BondPanel>
                      </BondPanelGroup>
                    </div>
                  </div>
                </template>

                <p v-if="comp.name === 'BondPanel'" class="text-sm text-muted italic">
                  See BondPanelGroup preview above for live demos.
                </p>
                <p v-if="comp.name === 'BondPanelHandle'" class="text-sm text-muted italic">
                  See BondPanelGroup preview above for live demos.
                </p>

                <!-- SessionSidebar -->
                <p v-if="comp.name === 'SessionSidebar'" class="text-sm text-muted italic">
                  Visible in the main app layout — see sidebar on the left.
                </p>
              </div>
            </div>
          </div>
        </div>
      </template>
  </main>
</template>

<style scoped>
.dev-list {
  padding-bottom: 2rem;
}

.dev-category {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-muted);
  margin: 1.25rem 0 0.5rem;
  padding: 0;
}
.dev-category:first-child {
  margin-top: 0;
}

.dev-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
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
  transition: background var(--transition-fast);
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
  font-family: var(--font-mono);
}

.dev-card-chevron {
  color: var(--color-muted);
  transition: transform var(--transition-base);
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
  border-radius: var(--radius-sm);
  font-size: 0.85em;
  font-family: var(--font-mono);
}

.dev-preview {
  margin-top: 0.25rem;
}

.dev-preview-area {
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
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

.dev-panel-content {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-muted);
  background: var(--color-surface);
}
</style>
