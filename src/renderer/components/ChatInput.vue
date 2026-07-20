<script setup lang="ts">
import { ref, computed, watch, toRefs, nextTick, onMounted } from 'vue'
import { PhArrowUp, PhCheck, PhPaperclip, PhSlidersHorizontal, PhX } from '@phosphor-icons/vue'
import { MODEL_IDS, type ModelId } from '../../shared/models'
import { ACCEPTED_IMAGE_TYPES, imageDataUri, type AttachedImage, type EditMode, type ImageMediaType } from '../../shared/session'
import { ISSUE_KEY_RE } from '../../shared/fields'
import type { CollectionReference } from '../../shared/rpc-schema'
import { useIssueReferences } from '../composables/useIssueReferences'
import BondButton from './BondButton.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import BondText from './BondText.vue'
import ContextGauge from './ContextGauge.vue'

const ISSUE_TOKEN_RE = new RegExp(ISSUE_KEY_RE.source, 'g')

function highlightMarkdownSyntax(text: string, knownKeys: ReadonlyMap<string, CollectionReference>): string {
  if (!text) return ''
  let result = text.split('\n').map(line => {
    let esc = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')


    // Blockquote: > at line start (escaped as &gt;)
    if (/^&gt;\s?/.test(esc)) {
      return esc.replace(/^(&gt;)(\s?)(.*)$/,
        '<span class="md-syn">$1</span>$2<span class="md-quote">$3</span>')
    }

    // Unordered list: - or * at line start
    const ulMatch = esc.match(/^(\s*)([-*])\s/)
    if (ulMatch) {
      esc = esc.replace(/^(\s*)([-*])(\s)/, '$1<span class="md-syn">$2</span>$3')
    }

    // Ordered list: 1. at line start
    const olMatch = esc.match(/^(\s*)(\d+\.)(\s)/)
    if (olMatch) {
      esc = esc.replace(/^(\s*)(\d+\.)(\s)/, '$1<span class="md-syn">$2</span>$3')
    }

    // Inline code: `text`
    esc = esc.replace(/(`)((?:(?!`).)+)(`)/g,
      '<span class="md-syn">$1</span><span class="md-code">$2</span><span class="md-syn">$3</span>')

    // Bold: **text**
    esc = esc.replace(/(\*\*)((?:(?!\*\*).)+)(\*\*)/g,
      '<span class="md-syn">$1</span><span class="md-bold">$2</span><span class="md-syn">$3</span>')

    // Italic: *text* (not adjacent to *)
    esc = esc.replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g,
      '<span class="md-syn">*</span><span class="md-italic">$1</span><span class="md-syn">*</span>')

    // Strikethrough: ~~text~~
    esc = esc.replace(/(~~)((?:(?!~~).)+)(~~)/g,
      '<span class="md-syn">$1</span><span class="md-strike">$2</span><span class="md-syn">$3</span>')

    // Issue references are rendered as compact tokens while retaining plain text
    // in the textarea, so the exact key is what gets sent to the agent. Only
    // known keys are decorated — "UTF-8"-style prose must stay plain.
    esc = esc.replace(ISSUE_TOKEN_RE, m => (knownKeys.has(m) ? `<span class="issue-token">${m}</span>` : m))

    return esc
  }).join('\n')

  // Trailing newline fix: browsers don't render a final empty line in pre-wrap,
  // but textareas do — causing the highlight to be one line shorter.
  if (result.endsWith('\n')) {
    result += ' '
  }

  return result
}

interface SkillInfo {
  name: string
  description: string
  argumentHint: string
}

const props = defineProps<{
  busy: boolean
  model: ModelId
  editMode: EditMode
  contextUsage?: { inputTokens: number; contextWindow: number; costUsd: number }
  placeholder?: string
}>()
const { busy } = toRefs(props)

const emit = defineEmits<{
  submit: [text: string, images: AttachedImage[]]
  cancel: []
  'update:model': [value: ModelId]
  'update:editMode': [value: EditMode]
}>()

const EDIT_MODE_OPTIONS = [
  { value: 'full', label: 'Full access' },
  { value: 'readonly', label: 'Read only' },
  { value: 'scoped', label: 'Scoped' }
] as const

const scopedPathsInput = ref('')

watch(() => props.editMode, (mode) => {
  if (mode?.type === 'scoped') {
    scopedPathsInput.value = mode.allowedPaths.join(', ')
  }
}, { immediate: true })

function handleEditModeChange(value: string) {
  const type = value as 'full' | 'readonly' | 'scoped'
  if (type === 'scoped') {
    scopedPathsInput.value = ''
    emit('update:editMode', { type: 'scoped', allowedPaths: [] })
  } else {
    emit('update:editMode', { type })
  }
}

function handleScopedPathsChange(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  scopedPathsInput.value = raw
  const paths = raw.split(',').map(p => p.trim()).filter(Boolean)
  emit('update:editMode', { type: 'scoped', allowedPaths: paths })
}

const modelLabels: Record<ModelId, string> = {
  high: 'High',
  balanced: 'Balanced',
  fast: 'Fast',
}

const settingsMenuOpen = ref(false)
const settingsButtonRef = ref<InstanceType<typeof BondButton> | null>(null)

const inputEl = ref<HTMLTextAreaElement | null>(null)
const previewEl = ref<HTMLElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
const attachedImages = ref<AttachedImage[]>([])
const inputText = ref('')

const inputHighlightHtml = computed(() => highlightMarkdownSyntax(inputText.value, issueRefsByKey.value))

function updatePreview() {
  inputText.value = inputEl.value?.value ?? ''
  // Re-sync scroll after Vue re-renders the highlight div (v-html reset scrollTop)
  nextTick(syncPreviewScroll)
}

function syncPreviewScroll() {
  if (previewEl.value && inputEl.value) {
    previewEl.value.scrollTop = inputEl.value.scrollTop
  }
}

watch(busy, (isBusy) => {
  if (!isBusy) {
    nextTick(() => inputEl.value?.focus())
  }
})

function handleSubmit() {
  const text = inputEl.value?.value.trim() ?? ''
  if (!text && !attachedImages.value.length) return
  inputEl.value!.value = ''
  inputText.value = ''
  emit('submit', text, attachedImages.value.map(i => ({ data: i.data, mediaType: i.mediaType })))
  attachedImages.value = []
  selectedImageIndex.value = null
  nextTick(autoResize)
  inputEl.value!.focus()
}

function focus() {
  inputEl.value?.focus()
}

function setText(text: string) {
  if (!inputEl.value) return
  inputEl.value.value = text
  inputText.value = text
  nextTick(() => {
    autoResize()
    inputEl.value?.focus()
    // Place cursor at end
    const len = inputEl.value?.value.length ?? 0
    inputEl.value?.setSelectionRange(len, len)
  })
}

defineExpose({ focus, setText })

function autoResize() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

function addImageFile(file: File) {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type as any)) return
  const reader = new FileReader()
  reader.onload = () => {
    const result = reader.result as string
    const base64 = result.split(',')[1]
    if (base64) {
      attachedImages.value.push({ data: base64, mediaType: file.type as ImageMediaType })
    }
  }
  reader.readAsDataURL(file)
}

function handleAttachClick() {
  fileInputEl.value?.click()
}

function handleFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files) return
  for (const file of Array.from(files)) addImageFile(file)
  ;(e.target as HTMLInputElement).value = ''
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type as any)) {
      const file = item.getAsFile()
      if (file) addImageFile(file)
    }
  }
}

const selectedImageIndex = ref<number | null>(null)

function removeImage(index: number) {
  attachedImages.value.splice(index, 1)
  if (selectedImageIndex.value === index) {
    selectedImageIndex.value = null
  } else if (selectedImageIndex.value !== null && selectedImageIndex.value > index) {
    selectedImageIndex.value--
  }
}

function selectImage(index: number) {
  selectedImageIndex.value = selectedImageIndex.value === index ? null : index
}

function deselectImage() {
  selectedImageIndex.value = null
}

function handleImageKeyDown(e: KeyboardEvent) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImageIndex.value !== null) {
    e.preventDefault()
    removeImage(selectedImageIndex.value)
  }
}

// --- Skill autocomplete ---
const skills = ref<SkillInfo[]>([])
// Singleton reference index — shared with MessageBubble, one RPC for all consumers.
const { references: issueReferences, byKey: issueRefsByKey, knownPrefixes: issuePrefixes } = useIssueReferences()
const showSkillMenu = ref(false)
const showIssueMenu = ref(false)
const issueMenuIndex = ref(0)
const issueMatchStart = ref(0)
const skillMenuIndex = ref(0)
const skillFilter = ref('')

const filteredSkills = computed(() => {
  if (!skillFilter.value) return skills.value
  const q = skillFilter.value.toLowerCase()
  return skills.value.filter(s => s.name.toLowerCase().startsWith(q))
})


const selectedIssueReferences = computed(() => {
  const seen = new Set<string>()
  const selected: CollectionReference[] = []
  for (const match of inputText.value.matchAll(ISSUE_TOKEN_RE)) {
    const ref = issueRefsByKey.value.get(match[0])
    if (ref && !seen.has(ref.key)) {
      seen.add(ref.key)
      selected.push(ref)
    }
  }
  return selected
})

const filteredIssueReferences = computed(() => {
  const el = inputEl.value
  if (!el) return []
  const fragment = el.value.slice(issueMatchStart.value, el.selectionStart ?? el.value.length).toUpperCase()
  const [prefix = '', number = ''] = fragment.split('-', 2)
  return issueReferences.value.filter(issue => {
    return issue.prefix.startsWith(prefix) &&
      (!fragment.includes('-') || String(issue.displayNumber).startsWith(number) || issue.title.toLowerCase().includes(number.toLowerCase()))
  }).slice(0, 8)
})

onMounted(() => {
  try {
    void window.bond.listSkills().then(result => { skills.value = result }).catch(() => { /* skills unavailable */ })
  } catch { /* compatibility test surfaces may omit skills */ }
})

function updateAutocomplete() {
  const el = inputEl.value
  if (!el) return
  const text = el.value
  const cursor = el.selectionStart ?? text.length

  // Only show menu when text starts with / and cursor is in the first word.
  if (text.startsWith('/') && (!text.includes(' ') || cursor <= text.indexOf(' ', 1))) {
    const partial = text.slice(1, cursor)
    if (/^[a-z0-9-]*$/.test(partial)) {
      skillFilter.value = partial
      skillMenuIndex.value = 0
      showSkillMenu.value = filteredSkills.value.length > 0
      showIssueMenu.value = false
      return
    }
  }
  showSkillMenu.value = false

  const beforeCursor = text.slice(0, cursor)
  // Issue lookup is deliberately quiet until a complete, KNOWN uppercase
  // tracker prefix is present. Normal prose should never summon a ticket list.
  const match = beforeCursor.match(/(?:^|\s)([A-Z]{2,6}(?:-\d*)?)$/)
  const prefix = match?.[1].split('-', 1)[0]
  if (match && prefix && issuePrefixes.value.has(prefix)) {
    issueMatchStart.value = cursor - match[1].length
    issueMenuIndex.value = 0
    showIssueMenu.value = filteredIssueReferences.value.length > 0
    return
  }
  showIssueMenu.value = false
}

function selectSkill(skill: SkillInfo) {
  const el = inputEl.value
  if (!el) return
  el.value = `/${skill.name} `
  inputText.value = el.value
  showSkillMenu.value = false
  el.focus()
  nextTick(autoResize)
}

function syncInput(value: string, cursor = value.length) {
  const el = inputEl.value
  if (!el) return
  el.value = value
  inputText.value = value
  nextTick(() => {
    el.focus()
    el.setSelectionRange(cursor, cursor)
    autoResize()
  })
}

function selectIssueReference(issue: CollectionReference) {
  const el = inputEl.value
  if (!el) return
  const cursor = el.selectionStart ?? el.value.length
  const after = el.value.slice(cursor)
  const spacer = after && !/^\s/.test(after) ? ' ' : ''
  const value = `${el.value.slice(0, issueMatchStart.value)}${issue.key}${spacer}${after}`
  showIssueMenu.value = false
  syncInput(value, issueMatchStart.value + issue.key.length + spacer.length)
}

function cancelIssueReference() {
  const el = inputEl.value
  if (!el) return
  const cursor = el.selectionStart ?? el.value.length
  showIssueMenu.value = false
  syncInput(`${el.value.slice(0, issueMatchStart.value)}${el.value.slice(cursor)}`, issueMatchStart.value)
}

function removeIssueReference(key: string) {
  const el = inputEl.value
  if (!el) return
  const expression = new RegExp(`(^|\\s)${key.replace('-', '\\-')}(?=\\s|$)`, 'i')
  const value = el.value.replace(expression, (_match, before: string) => before)
  syncInput(value.replace(/ {2,}/g, ' ').trimStart())
}

function setIssueMenuIndex(index: number) {
  issueMenuIndex.value = Math.max(0, Math.min(index, filteredIssueReferences.value.length - 1))
  nextTick(() => {
    const option = document.querySelector<HTMLElement>(`.issue-menu-item[data-issue-index="${issueMenuIndex.value}"]`)
    option?.scrollIntoView({ block: 'nearest' })
  })
}

function handleKeyDown(e: KeyboardEvent) {
  if (showIssueMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIssueMenuIndex(issueMenuIndex.value + 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIssueMenuIndex(issueMenuIndex.value - 1)
      return
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      const issue = filteredIssueReferences.value[issueMenuIndex.value]
      if (issue) selectIssueReference(issue)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelIssueReference()
      return
    }
  }
  if (showSkillMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      skillMenuIndex.value = Math.min(skillMenuIndex.value + 1, filteredSkills.value.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      skillMenuIndex.value = Math.max(skillMenuIndex.value - 1, 0)
      return
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      const skill = filteredSkills.value[skillMenuIndex.value]
      if (skill) selectSkill(skill)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      showSkillMenu.value = false
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmit()
  }
}
</script>

<template>
  <div class="chat-composer pt-1 relative pb-2">
    <!-- Skill autocomplete menu -->
    <BondFlyoutMenu
      :open="showIssueMenu"
      :anchor="inputEl"
      placement="top-start"
      :width="360"
      padding
      @close="showIssueMenu = false"
    >
      <div class="skill-menu issue-menu" role="listbox" aria-label="Issue references">
        <button
          v-for="(issue, i) in filteredIssueReferences"
          :key="issue.itemId"
          type="button"
          class="skill-menu-item issue-menu-item"
          :class="{ 'is-selected': i === issueMenuIndex }"
          :data-issue-index="i"
          @mousedown.prevent="selectIssueReference(issue)"
          @mouseenter="issueMenuIndex = i"
        >
          <span class="issue-key">{{ issue.key }}</span>
          <span class="text-text-primary text-sm truncate">{{ issue.title }}</span>
        </button>
      </div>
    </BondFlyoutMenu>

    <div v-if="showSkillMenu" class="skill-menu">
      <button
        v-for="(skill, i) in filteredSkills"
        :key="skill.name"
        type="button"
        class="skill-menu-item"
        :class="{ 'is-selected': i === skillMenuIndex }"
        @mousedown.prevent="selectSkill(skill)"
        @mouseenter="skillMenuIndex = i"
      >
        <span class="text-text-primary text-sm font-medium">/{{ skill.name }}</span>
        <span class="text-muted text-xs truncate">{{ skill.description }}</span>
      </button>
    </div>


    <div class="chat-box" @click="deselectImage">
      <!-- Image preview strip -->
      <div
        v-if="attachedImages.length"
        class="image-strip"
        tabindex="0"
        @keydown="handleImageKeyDown"
      >
        <div
          v-for="(img, i) in attachedImages"
          :key="i"
          class="image-thumb group relative cursor-pointer"
          :class="{ 'ring-2 ring-accent rounded-lg': selectedImageIndex === i }"
          @click.stop="selectImage(i)"
        >
          <img :src="imageDataUri(img)" class="rounded-lg object-cover max-h-28 max-w-48" />
          <button
            type="button"
            class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface border border-border text-muted cursor-pointer flex items-center justify-center p-0 transition-opacity duration-[var(--transition-fast)] hover:text-text-primary"
            :class="selectedImageIndex === i ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
            @click.stop="removeImage(i)"
          >
            <PhX :size="10" weight="bold" />
          </button>
        </div>
      </div>

      <!-- Textarea with markdown preview overlay -->
      <div class="chat-textarea-wrapper">
        <div
          v-if="inputText"
          ref="previewEl"
          class="chat-highlight"
          aria-hidden="true"
          v-html="inputHighlightHtml"
        />
        <textarea
          ref="inputEl"
          rows="1"
          :placeholder="props.placeholder ?? 'Ask Bond something…'"
          :spellcheck="false"
          @keydown="handleKeyDown"
          @input="autoResize(); updateAutocomplete(); updatePreview()"
          @paste="handlePaste"
          @scroll="syncPreviewScroll"
          class="chat-textarea"
          :class="{ 'has-highlight': inputText }"
        />
      </div>

      <div v-if="selectedIssueReferences.length" class="issue-token-strip" aria-label="Referenced issues">
        <button
          v-for="issue in selectedIssueReferences"
          :key="issue.itemId"
          type="button"
          class="issue-reference-token"
          :title="issue.title"
          @click="focus()"
        >
          <span>{{ issue.key }}</span>
          <span class="issue-reference-title">{{ issue.title }}</span>
          <span class="issue-reference-remove" role="button" aria-label="Remove issue reference" @click.stop="removeIssueReference(issue.key)"><PhX :size="12" weight="bold" /></span>
        </button>
      </div>

      <!-- Scoped paths input -->
      <div v-if="editMode.type === 'scoped'" class="px-3 pt-2">
        <input
          type="text"
          :value="scopedPathsInput"
          placeholder="~/Projects/myapp, ~/Documents"
          @change="handleScopedPathsChange"
          class="w-full py-1 px-2.5 border border-border rounded-md bg-transparent text-text-primary text-sm font-sans placeholder:text-muted focus:outline-2 focus:outline-accent focus:-outline-offset-1"
        />
      </div>

      <!-- Toolbar -->
      <div class="composer-toolbar flex items-center justify-between pt-1">
        <!-- self-end: the 26px ghost button otherwise centers against the 32px
             send button and its bottom edge floats 3px high. -->
        <div class="flex items-center gap-s self-end">
          <BondButton
            variant="ghost"
            size="sm"
            icon
            @click="handleAttachClick"
            v-tooltip="'Attach image'"
          >
            <PhPaperclip :size="16" weight="bold" />
          </BondButton>
          <input
            ref="fileInputEl"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            class="file-input"
            @change="handleFileChange"
          />
        </div>
        <div class="flex items-center gap-3">
          <ContextGauge
            v-if="contextUsage"
            :used="contextUsage.inputTokens"
            :limit="contextUsage.contextWindow"
            :cost="contextUsage.costUsd"
          />
          <BondButton
            ref="settingsButtonRef"
            data-action="composer-settings"
            variant="ghost"
            size="sm"
            icon
            :aria-expanded="settingsMenuOpen"
            aria-haspopup="menu"
            aria-label="Reasoning and permissions"
            @click.stop="settingsMenuOpen = !settingsMenuOpen"
            v-tooltip="'Reasoning and permissions'"
          >
            <PhSlidersHorizontal :size="16" weight="bold" />
          </BondButton>
          <BondFlyoutMenu
            :open="settingsMenuOpen"
            :anchor="settingsButtonRef?.$el ?? null"
            placement="top-end"
            :width="244"
            padding
            @close="settingsMenuOpen = false"
          >
            <div class="composer-settings-section">
              <BondText as="div" size="xs" weight="medium" color="muted" class="composer-settings-label">Reasoning</BondText>
              <button
                v-for="modelId in MODEL_IDS"
                :key="modelId"
                type="button"
                class="composer-settings-option"
                :data-model="modelId"
                role="menuitemradio"
                :aria-checked="model === modelId"
                @click="emit('update:model', modelId)"
              >
                <span>{{ modelLabels[modelId] }}</span>
                <PhCheck v-if="model === modelId" :size="14" weight="bold" />
              </button>
            </div>
            <div class="composer-settings-divider" />
            <div class="composer-settings-section">
              <BondText as="div" size="xs" weight="medium" color="muted" class="composer-settings-label">Permissions</BondText>
              <button
                v-for="option in EDIT_MODE_OPTIONS"
                :key="option.value"
                type="button"
                class="composer-settings-option"
                :data-edit-mode="option.value"
                role="menuitemradio"
                :aria-checked="editMode.type === option.value"
                @click="handleEditModeChange(option.value)"
              >
                <span>{{ option.label }}</span>
                <PhCheck v-if="editMode.type === option.value" :size="14" weight="bold" />
              </button>
            </div>
          </BondFlyoutMenu>
          <BondButton
            v-if="busy"
            variant="ghost"
            size="sm"
            style="font-weight: normal"
            @click="emit('cancel')"
          >
            Esc to stop
          </BondButton>
          <button
            type="button"
            data-action="send"
            class="flex items-center justify-center w-8 h-8 rounded-full border-none cursor-pointer bg-accent text-white hover:opacity-85"
            @click="handleSubmit()"
          >
            <PhArrowUp :size="16" weight="bold" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-composer {
  /* Extend the surface to the conversation gutter; textarea padding then puts
     its text exactly on the same left edge as assistant messages. */
  margin-inline: -0.75rem;
}

.chat-box {
  border: 0;
  border-radius: 16px;
  background: var(--color-surface);
  transition: outline-color var(--transition-fast);
}

.chat-box:focus-within {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.composer-toolbar {
  padding: 0 0.5rem 0.25rem;
}

.file-input {
  display: none;
}

.chat-textarea-wrapper {
  position: relative;
}

.chat-highlight {
  position: absolute;
  inset: 0;
  pointer-events: none;
  padding: 0.625rem 0.75rem 0.375rem;
  font: inherit;
  font-size: 1rem;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow: hidden;
  z-index: 1;
}

.chat-textarea {
  display: block;
  width: 100%;
  resize: none;
  max-height: 12rem;
  overflow-y: auto;
  padding: 0.625rem 0.75rem 0.375rem;
  border-radius: var(--radius-xl);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 1rem;
  outline: none;
}
.chat-textarea.has-highlight {
  color: transparent;
  caret-color: var(--color-text-primary);
}
.chat-textarea::placeholder {
  color: var(--color-muted);
}

/* Markdown syntax highlighting in input */
.chat-highlight :deep(.md-syn) {
  opacity: 0.3;
}
.chat-highlight :deep(.md-bold) {
  color: var(--color-accent);
}
.chat-highlight :deep(.md-italic) {
  font-style: italic;
}
.chat-highlight :deep(.md-code) {
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  border-radius: 2px;
}
.chat-highlight :deep(.md-quote) {
  color: var(--color-muted);
  font-style: italic;
}
.chat-highlight :deep(.md-strike) {
  text-decoration: line-through;
  opacity: 0.6;
}
.chat-highlight :deep(.issue-token) {
  display: inline-block;
  padding: 0 0.25em;
  border-radius: 0.3em;
  background: color-mix(in srgb, var(--color-accent) 24%, transparent);
  color: var(--color-accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.88em;
  font-weight: 700;
}


.issue-token-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.15rem 0.5rem 0.35rem;
}

.issue-reference-token {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 0.4rem;
  padding: 0.18rem 0.42rem;
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  border-radius: 0.4rem;
  background: color-mix(in srgb, var(--color-accent) 13%, transparent);
  color: var(--color-accent);
  cursor: pointer;
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
  font-weight: 700;
}

.issue-reference-token:hover {
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
}

.issue-reference-title {
  overflow: hidden;
  color: var(--color-text-primary);
  font-family: inherit;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-reference-remove {
  display: inline-flex;
  align-items: center;
  margin-left: 0.05rem;
  color: var(--color-muted);
}

.issue-reference-token:hover .issue-reference-remove {
  color: var(--color-text-primary);
}

.image-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-left: 1px;
  margin-bottom: 0.5rem;
  outline: none;
}

.skill-menu {
  position: absolute;
  bottom: 100%;
  left: 20px;
  right: 20px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  z-index: 10;
}

.skill-menu-item {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 8px 10px;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: var(--radius-md);
  text-align: left;
  transition: background var(--transition-fast);
}
.skill-menu-item.is-selected {
  background: var(--color-tint);
}

.issue-menu {
  position: static;
  left: auto;
  right: auto;
  bottom: auto;
  max-height: 240px;
  margin: 0;
  padding: 0;
  border: 0;
  box-shadow: none;
}

.issue-menu-item {
  gap: 0.6rem;
}

.issue-key {
  flex: 0 0 auto;
  color: var(--color-accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  font-weight: 700;
}

.composer-settings-section {
  display: flex;
  flex-direction: column;
}

.composer-settings-label {
  padding: 0.5rem 0.625rem 0.25rem;
}

.composer-settings-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.45rem 0.625rem;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.composer-settings-option:hover,
.composer-settings-option:focus-visible {
  background: var(--color-tint);
  outline: none;
}

.composer-settings-option svg {
  flex-shrink: 0;
  color: var(--color-accent);
}

.composer-settings-divider {
  height: 1px;
  margin: 0.25rem 0.375rem;
  background: var(--color-border);
}
</style>
