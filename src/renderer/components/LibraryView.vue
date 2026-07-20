<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { AttachedImage } from '../../shared/session'
import { imageDataUri } from '../../shared/session'
import type { AssetBacklink, AssetFormat, LibraryAsset } from '../../shared/library'
import { useLibrary } from '../composables/useLibrary'
import { openLibraryAsset, revealLibraryAsset } from '../lib/library'
import BondText from './BondText.vue'
import BondToolbar from './BondToolbar.vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondTab from './BondTab.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import { PhPlus, PhTrash, PhFileMd, PhFileText, PhFilePdf, PhFileHtml, PhFile, PhFolderOpen } from '@phosphor-icons/vue'

const { assets, kindFilter, query, loading, load, deleteAsset } = useLibrary()

const imageData = ref<Map<string, AttachedImage>>(new Map())
const loadedCount = ref(0)
const confirmDeleteId = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
let removeLibraryListener: (() => void) | null = null
const IMAGE_BATCH_SIZE = 12

const FILTER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Documents' },
  { id: 'media', label: 'Media' },
]

const FORMAT_ICON: Record<AssetFormat, unknown> = {
  markdown: PhFileMd,
  plaintext: PhFileText,
  pdf: PhFilePdf,
  html: PhFileHtml,
  other: PhFile,
  image: PhFile,
}

function mediaAssets(): LibraryAsset[] {
  return assets.value.filter(a => a.kind === 'media')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Guards against a filter/search change firing a new reload() while a
// previous one is still mid-batch: without this, the stale loop keeps
// reading `assets.value` (already swapped to the new filter's results) via
// mediaAssets(), gets an ever-empty batch, and spins forever since
// loadedCount never advances past its now-meaningless `total`.
let reloadGeneration = 0

async function loadNextImageBatch(myGeneration: number) {
  const media = mediaAssets()
  const batch = media.slice(loadedCount.value, loadedCount.value + IMAGE_BATCH_SIZE)
  if (!batch.length) return
  const images = await window.bond.getImages(batch.map(a => a.id))
  if (myGeneration !== reloadGeneration) return // superseded while awaiting
  const next = new Map(imageData.value)
  batch.forEach((asset, i) => {
    if (images[i]) next.set(asset.id, images[i]!)
  })
  imageData.value = next
  loadedCount.value += batch.length
}

async function reload() {
  const myGeneration = ++reloadGeneration
  await load()
  if (myGeneration !== reloadGeneration) return
  imageData.value = new Map()
  loadedCount.value = 0
  const total = mediaAssets().length
  while (loadedCount.value < total) {
    if (myGeneration !== reloadGeneration) return
    await loadNextImageBatch(myGeneration)
  }
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null
watch([kindFilter, query], () => {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(reload, 250)
})

// Cursor-following info card — same idiom as MessageBubble's issue hover card.
const hoverInfo = ref<{ asset: LibraryAsset; x: number; y: number } | null>(null)
const backlinks = ref<Map<string, AssetBacklink[]>>(new Map())
const backlinksRequested = new Set<string>()

const HOVER_CARD_W = 260
const HOVER_CARD_H = 150

/** Clamped so the card never runs off the right/bottom edge of the window. */
const hoverCardStyle = computed(() => {
  if (!hoverInfo.value) return {}
  const x = Math.min(hoverInfo.value.x, window.innerWidth - HOVER_CARD_W - 12)
  const y = Math.min(hoverInfo.value.y, window.innerHeight - HOVER_CARD_H - 12)
  return { left: `${Math.max(12, x)}px`, top: `${Math.max(12, y)}px` }
})

function updateHover(asset: LibraryAsset, event: MouseEvent) {
  hoverInfo.value = { asset, x: event.clientX + 14, y: event.clientY + 16 }
  void ensureBacklinks(asset.id)
}

/** Fetched once per asset and cached — a mousemove must not spam the daemon. */
async function ensureBacklinks(assetId: string) {
  if (backlinksRequested.has(assetId)) return
  backlinksRequested.add(assetId)
  try {
    const links = await window.bond.libraryListBacklinksForAsset(assetId)
    backlinks.value = new Map(backlinks.value).set(assetId, links)
  } catch {
    backlinksRequested.delete(assetId) // let a later hover retry
  }
}

async function removeAsset(asset: LibraryAsset) {
  if (confirmDeleteId.value !== asset.id) {
    confirmDeleteId.value = asset.id
    return
  }
  confirmDeleteId.value = ''
  await deleteAsset(asset.id)
}

function chooseFile() {
  fileInput.value?.click()
}

async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  for (const file of files) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    const comma = dataUrl.indexOf(',')
    if (comma === -1) continue
    const data = dataUrl.slice(comma + 1)
    if (file.type.startsWith('image/')) {
      await window.bond.importImage(data, file.type)
    } else {
      const format = extToFormat(file.name)
      await window.bond.libraryAddDocument({ filename: file.name, mediaType: file.type || 'application/octet-stream', format, data })
    }
  }
  await reload()
}

function extToFormat(filename: string): AssetFormat {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.txt') return 'plaintext'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.pdf') return 'pdf'
  return 'other'
}

onMounted(async () => {
  removeLibraryListener = window.bond.onLibraryChanged(reload)
  await reload()
})

onUnmounted(() => {
  removeLibraryListener?.()
})
</script>

<template>
  <div class="library-panel">
    <BondToolbar label="Library" drag blur class="library-panel-toolbar">
      <template #start>
        <BondText size="sm" weight="medium" color="muted">Library</BondText>
        <span v-if="assets.length" class="library-panel-badge">{{ assets.length }}</span>
      </template>
      <template #end>
        <input ref="fileInput" type="file" multiple hidden @change="importFiles" />
        <BondButton variant="ghost" size="sm" icon @click="chooseFile" v-tooltip="'Add to Library'">
          <PhPlus :size="16" weight="bold" />
        </BondButton>
      </template>
    </BondToolbar>

    <div class="library-panel-filters">
      <BondTab :tabs="FILTER_TABS" v-model="kindFilter" />
      <BondInput v-model="query" placeholder="Search…" />
    </div>

    <div class="library-panel-scroll">
      <div v-if="loading" class="library-empty">
        <BondText size="sm" color="muted">Loading...</BondText>
      </div>

      <div v-else-if="assets.length === 0" class="library-empty">
        <BondText size="sm" color="muted">Nothing in the Library yet.</BondText>
      </div>

      <div v-else class="library-grid">
        <div
          v-for="asset in assets"
          :key="asset.id"
          class="library-item"
          @dblclick="openLibraryAsset(asset)"
          @mousemove="updateHover(asset, $event)"
          @mouseleave="hoverInfo = null"
        >
          <div class="library-thumb">
            <img
              v-if="asset.kind === 'media' && imageData.get(asset.id)"
              :src="imageDataUri(imageData.get(asset.id)!)"
              :alt="asset.title"
              loading="lazy"
            />
            <div v-else-if="asset.kind === 'media'" class="library-placeholder" />
            <!-- Documents render as a scaled-down page through the SAME
                 renderer the viewer window uses, so the tile is a true
                 miniature of what a double-click opens. -->
            <div v-else class="library-doc-preview">
              <div v-if="asset.previewText" class="library-doc-page">
                <MarkdownMessage :text="asset.previewText" :streaming="false" />
              </div>
              <component v-else :is="FORMAT_ICON[asset.format]" :size="28" />
            </div>
            <div class="library-meta">
              <BondText size="xs" truncate>{{ asset.title }}</BondText>
              <div class="library-actions">
                <BondButton variant="ghost" size="sm" icon @click.stop="revealLibraryAsset(asset)" v-tooltip="'Reveal in Finder'">
                  <PhFolderOpen :size="13" />
                </BondButton>
                <BondButton
                  variant="ghost"
                  size="sm"
                  icon
                  @click.stop="removeAsset(asset)"
                  v-tooltip="confirmDeleteId === asset.id ? 'Click again to remove' : 'Delete'"
                >
                  <PhTrash :size="13" />
                </BondButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="hoverInfo" class="library-info-card" :style="hoverCardStyle">
        <BondText as="div" size="sm" weight="semibold" truncate>{{ hoverInfo.asset.title }}</BondText>
        <BondText as="div" size="xs" color="muted">
          {{ hoverInfo.asset.kind }} · {{ hoverInfo.asset.format }} · {{ formatSize(hoverInfo.asset.sizeBytes) }}
        </BondText>
        <template v-if="backlinks.get(hoverInfo.asset.id)">
          <BondText as="div" size="xs" weight="semibold" color="muted" class="library-info-label">
            Referenced in ({{ backlinks.get(hoverInfo.asset.id)!.length }})
          </BondText>
          <div v-if="backlinks.get(hoverInfo.asset.id)!.length" class="library-info-backlinks">
            <BondText v-for="b in backlinks.get(hoverInfo.asset.id)!" :key="b.itemId" as="div" size="xs" color="muted">
              {{ b.collectionName }} · {{ b.itemKey ?? b.itemLabel }}
            </BondText>
          </div>
          <BondText v-else as="div" size="xs" color="muted">Not referenced by any collection item.</BondText>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.library-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.library-panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.library-panel-badge {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  min-width: 1.125rem;
  height: 1.125rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.3125rem;
  border-radius: 999px;
  background: var(--color-accent, var(--color-text-primary));
  color: var(--color-bg, #fff);
}

.library-panel-filters {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  flex-shrink: 0;
}

.library-panel-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 0.5rem 0.75rem 2rem;
}

.library-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
}

.library-grid {
  columns: 140px;
  column-gap: 0.375rem;
}

.library-item {
  break-inside: avoid;
  margin-bottom: 0.375rem;
  cursor: pointer;
}

.library-thumb {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  min-height: 5.5rem;
}

.library-thumb img {
  width: 100%;
  display: block;
}

.library-placeholder {
  width: 100%;
  height: 100%;
  background: var(--color-surface);
}

.library-doc-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-muted);
}

/*
 * A real page miniature: render at full document width, then scale the whole
 * thing down. Shrinking the font instead would flatten the heading/body
 * hierarchy — this keeps the exact proportions of the viewer window.
 */
.library-doc-page {
  position: absolute;
  top: 0;
  left: 0;
  width: 360px;
  padding: 14px 16px;
  transform: scale(0.36);
  transform-origin: top left;
  pointer-events: none;
}

.library-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0.375rem;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  color: rgba(255, 255, 255, 0.9);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.library-item:hover .library-meta {
  opacity: 1;
}

.library-actions {
  display: flex;
  gap: 0.125rem;
  flex-shrink: 0;
}

.library-info-card {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  width: 260px;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
  pointer-events: none;
}

.library-info-label {
  margin-top: 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.library-info-backlinks {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
</style>
