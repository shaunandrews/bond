<script setup lang="ts">
import { ref, computed, watch, toRefs, nextTick, onMounted } from 'vue'
import { PhArrowUp, PhPaperclip, PhStop, PhX } from '@phosphor-icons/vue'
import { MODEL_IDS, type ModelId } from '../../shared/models'
import { ACCEPTED_IMAGE_TYPES, imageDataUri, type AttachedImage, type EditMode } from '../../shared/session'
import type { WordPressSite } from '../../shared/wordpress'
import BondSelect from './BondSelect.vue'

interface SkillInfo {
  name: string
  description: string
  argumentHint: string
}

const props = defineProps<{ busy: boolean; model: ModelId; editMode: EditMode; wordPressSites?: WordPressSite[]; siteId?: string }>()
const { busy } = toRefs(props)

const emit = defineEmits<{
  submit: [text: string, images: AttachedImage[]]
  cancel: []
  'update:model': [value: ModelId]
  'update:editMode': [value: EditMode]
  'update:siteId': [value: string | undefined]
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

const siteOptions = computed(() => {
  const opts = [{ value: '', label: 'No site' }]
  if (props.wordPressSites?.length) {
    for (const s of props.wordPressSites) {
      opts.push({ value: s.id, label: s.name })
    }
  }
  return opts
})

function handleSiteChange(value: string) {
  emit('update:siteId', value || undefined)
}

const inputEl = ref<HTMLTextAreaElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
const attachedImages = ref<AttachedImage[]>([])

watch(busy, (isBusy) => {
  if (!isBusy) {
    nextTick(() => inputEl.value?.focus())
  }
})

function handleSubmit() {
  const text = inputEl.value?.value.trim() ?? ''
  if (!text && !attachedImages.value.length) return
  inputEl.value!.value = ''
  emit('submit', text, attachedImages.value.map(i => ({ data: i.data, mediaType: i.mediaType })))
  attachedImages.value = []
  selectedImageIndex.value = null
  nextTick(autoResize)
  inputEl.value!.focus()
}

function focus() {
  inputEl.value?.focus()
}

defineExpose({ focus })

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
      attachedImages.value.push({ data: base64, mediaType: file.type })
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
  <div class="px-5 pt-3 pb-5 relative">
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

      <!-- Textarea -->
      <textarea
        ref="inputEl"
        rows="2"
        placeholder="Ask Bond something…"
        :spellcheck="false"
        :disabled="busy"
        @keydown="handleKeyDown"
        @input="autoResize(); updateSkillMenu()"
        @paste="handlePaste"
        class="chat-textarea"
      />

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
          <BondSelect
            v-if="wordPressSites && wordPressSites.length > 0"
            :modelValue="siteId ?? ''"
            :options="siteOptions"
            placement="top"
            variant="minimal"
            size="sm"
            @update:modelValue="handleSiteChange"
          />
          <button
            type="button"
            :disabled="busy"
            @click="handleAttachClick"
            class="flex items-center justify-center w-7 h-7 rounded-md border border-border bg-transparent text-muted cursor-pointer transition-colors duration-[var(--transition-fast)] hover:text-text-primary disabled:opacity-45 disabled:cursor-not-allowed"
            title="Attach image"
          >
            <PhPaperclip :size="16" weight="regular" />
          </button>
          <input
            ref="fileInputEl"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            class="hidden"
            @change="handleFileChange"
          />
        </div>

        <!-- Combined action button -->
        <button
          v-if="busy"
          type="button"
          data-action="stop"
          class="flex items-center justify-center w-8 h-8 rounded-full border-none cursor-pointer bg-border text-text-primary hover:opacity-85"
          @click="emit('cancel')"
        >
          <PhStop :size="16" weight="fill" />
        </button>
        <button
          v-else
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
</template>

<style scoped>
.chat-box {
  border-top: 1px solid rgba(255,255,255,0.1);
  /* box-shadow: 0 1px 0 rgba(255,255,255,0.15); */
  border-radius: 18px 18px 22px 12px;
  padding: 6px;
  background: var(--color-tint);
  backdrop-filter: blur(12px);
  transition: border-color var(--transition-fast);
}

.chat-textarea {
  display: block;
  width: 100%;
  resize: none;
  max-height: 12rem;
  overflow-y: auto;
  padding: 0.75rem 0.75rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 1rem;
  outline: none;
}
.chat-textarea::placeholder {
  color: var(--color-muted);
}
.chat-textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
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
