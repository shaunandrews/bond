<script setup lang="ts">
import { ref, watch, toRefs, nextTick, onMounted } from 'vue'
import { PhArrowUp, PhCaretDown, PhPaperclip, PhStop, PhX } from '@phosphor-icons/vue'
import { MODEL_IDS, type ModelId } from '../../shared/models'
import { ACCEPTED_IMAGE_TYPES, imageDataUri, type AttachedImage, type EditMode } from '../../shared/session'

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

function handleEditModeChange(e: Event) {
  const type = (e.target as HTMLSelectElement).value as 'full' | 'readonly' | 'scoped'
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

const models = MODEL_IDS.map(id => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))

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

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmit()
  }
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
</script>

<template>
  <div class="px-5 pt-3 pb-5">
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
        @input="autoResize"
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
      <div class="flex items-center justify-between pt-2">
        <div class="flex items-center gap-2">
          <div class="relative inline-block">
            <select
              :value="model"
              class="toolbar-select"
              @change="emit('update:model', ($event.target as HTMLSelectElement).value as ModelId)"
            >
              <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
            <PhCaretDown class="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" :size="12" weight="bold" />
          </div>
          <div class="relative inline-block">
            <select
              :value="editMode.type"
              class="toolbar-select"
              @change="handleEditModeChange"
            >
              <option v-for="opt in EDIT_MODE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <PhCaretDown class="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" :size="12" weight="bold" />
          </div>
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
  border: 1px solid var(--color-border);
  border-radius: 18px 18px 22px 12px;
  padding: 6px;
  background: var(--color-tint);
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

.toolbar-select {
  appearance: none;
  background: transparent;
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.3em 2em 0.3em 0.6em;
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
}
.toolbar-select:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
