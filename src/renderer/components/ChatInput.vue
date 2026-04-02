<script setup lang="ts">
import { ref, computed, watch, toRefs, nextTick, onMounted } from 'vue'
import { PhArrowUp, PhPaperclip, PhX } from '@phosphor-icons/vue'
import { MODEL_IDS, type ModelId } from '../../shared/models'
import { ACCEPTED_IMAGE_TYPES, imageDataUri, type AttachedImage, type EditMode, type ImageMediaType } from '../../shared/session'
import BondButton from './BondButton.vue'
import BondSelect from './BondSelect.vue'

function highlightMarkdownSyntax(text: string): string {
  if (!text) return ''
  return text.split('\n').map(line => {
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

    return esc
  }).join('\n')
}

interface SkillInfo {
  name: string
  description: string
  argumentHint: string
}

const props = defineProps<{ busy: boolean; model: ModelId; editMode: EditMode }>()
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

const modelOptions = MODEL_IDS.map(id => ({ value: id, label: id.charAt(0).toUpperCase() + id.slice(1) }))
const editModeOptions = EDIT_MODE_OPTIONS.map(o => ({ value: o.value, label: o.label }))

const inputEl = ref<HTMLTextAreaElement | null>(null)
const previewEl = ref<HTMLElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
const attachedImages = ref<AttachedImage[]>([])
const inputText = ref('')

const inputHighlightHtml = computed(() => highlightMarkdownSyntax(inputText.value))

function updatePreview() {
  inputText.value = inputEl.value?.value ?? ''
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
const showSkillMenu = ref(false)
const skillMenuIndex = ref(0)
const skillFilter = ref('')

const filteredSkills = computed(() => {
  if (!skillFilter.value) return skills.value
  const q = skillFilter.value.toLowerCase()
  return skills.value.filter(s => s.name.toLowerCase().startsWith(q))
})

onMounted(async () => {
  try {
    skills.value = await window.bond.listSkills()
  } catch { /* skills not available yet */ }
})

function updateSkillMenu() {
  const el = inputEl.value
  if (!el) return
  const text = el.value
  const cursor = el.selectionStart ?? text.length

  // Only show menu when text starts with / and cursor is in the first word
  if (text.startsWith('/') && (!text.includes(' ') || cursor <= text.indexOf(' ', 1))) {
    const partial = text.slice(1, cursor)
    if (/^[a-z0-9-]*$/.test(partial)) {
      skillFilter.value = partial
      skillMenuIndex.value = 0
      showSkillMenu.value = filteredSkills.value.length > 0
      return
    }
  }
  showSkillMenu.value = false
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

function handleKeyDown(e: KeyboardEvent) {
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
  <div class="pt-2 pb-5 relative">
    <!-- Skill autocomplete menu -->
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
          rows="2"
          placeholder="Ask Bond something…"
          :spellcheck="false"
          @keydown="handleKeyDown"
          @input="autoResize(); updateSkillMenu(); updatePreview()"
          @paste="handlePaste"
          @scroll="syncPreviewScroll"
          class="chat-textarea"
          :class="{ 'has-highlight': inputText }"
        />
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
      <div class="flex items-center justify-between pt-1">
        <div class="flex items-center gap-s">
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
            class="hidden"
            @change="handleFileChange"
          />
          <BondSelect
            :modelValue="model"
            :options="modelOptions"
            placement="top"
            variant="minimal"
            size="sm"
            @update:modelValue="emit('update:model', $event as ModelId)"
          />
          <BondSelect
            :modelValue="editMode.type"
            :options="editModeOptions"
            placement="top"
            variant="minimal"
            size="sm"
            @update:modelValue="handleEditModeChange"
          />
        </div>
        <div class="flex items-center gap-s">
          <BondButton
            v-if="busy"
            variant="ghost"
            size="sm"
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
.chat-box {
  /* border-top: 1px solid rgba(255,255,255,0.1); */
  /* box-shadow: 0 1px 0 rgba(255,255,255,0.15); */
  border-radius: 18px 18px 22px 12px;
  padding: 6px;
  background: var(--color-tint);
  backdrop-filter: blur(24px);
  transition: all var(--transition-fast);
}
.chat-box:focus-within {
  /* border-color: var(--color-accent); */
  box-shadow: 0 0 0 2px var(--color-accent);
  background: var(--color-surface);
}

.chat-textarea-wrapper {
  position: relative;
}

.chat-highlight {
  position: absolute;
  inset: 0;
  pointer-events: none;
  padding: 0.75rem 0.75rem 0.5rem;
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
  padding: 0.75rem 0.75rem 0.5rem;
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
</style>
