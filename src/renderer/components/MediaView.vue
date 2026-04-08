<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { ImageRecord, AttachedImage } from '../../shared/session'
import { imageDataUri } from '../../shared/session'
import BondText from './BondText.vue'
import BondToolbar from './BondToolbar.vue'

const records = ref<ImageRecord[]>([])
const imageData = ref<Map<string, AttachedImage>>(new Map())
const loading = ref(true)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const totalSize = computed(() => {
  const bytes = records.value.reduce((sum, r) => sum + r.sizeBytes, 0)
  return formatSize(bytes)
})

function openImage(record: ImageRecord) {
  const img = imageData.value.get(record.id)
  if (!img) return
  const src = imageDataUri(img)
  const win = window.open('', '_blank', 'width=800,height=600')
  if (!win) return
  win.document.title = record.filename
  win.document.body.style.cssText = 'margin:0;background:#0f1114;display:flex;align-items:center;justify-content:center;height:100vh'
  const el = win.document.createElement('img')
  el.src = src
  el.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain'
  win.document.body.appendChild(el)
}

onMounted(async () => {
  try {
    records.value = await window.bond.listImages()
    if (records.value.length) {
      const ids = records.value.map(r => r.id)
      const images = await window.bond.getImages(ids)
      const map = new Map<string, AttachedImage>()
      ids.forEach((id, i) => {
        if (images[i]) map.set(id, images[i]!)
      })
      imageData.value = map
    }
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="media-panel">
    <BondToolbar label="Media" drag blur class="media-panel-toolbar">
      <template #start>
        <BondText size="sm" weight="medium" color="muted">Media</BondText>
        <span v-if="records.length" class="media-panel-badge">{{ records.length }}</span>
      </template>
    </BondToolbar>

    <div class="media-panel-scroll">
      <div v-if="loading" class="media-empty">
        <BondText size="sm" color="muted">Loading...</BondText>
      </div>

      <div v-else-if="records.length === 0" class="media-empty">
        <BondText size="sm" color="muted">No images uploaded yet.</BondText>
      </div>

      <template v-else>
        <div class="media-summary">
          <BondText size="xs" color="muted">{{ records.length }} image{{ records.length === 1 ? '' : 's' }} &middot; {{ totalSize }}</BondText>
        </div>

        <div class="media-grid">
          <div
            v-for="record in records"
            :key="record.id"
            class="media-item"
            @dblclick="openImage(record)"
          >
            <div class="media-thumb">
              <img
                v-if="imageData.get(record.id)"
                :src="imageDataUri(imageData.get(record.id)!)"
                :alt="record.filename"
                loading="lazy"
              />
              <div v-else class="media-placeholder" />
              <div class="media-meta">
                <BondText size="xs" truncate>{{ formatSize(record.sizeBytes) }}</BondText>
                <BondText size="xs">{{ formatDate(record.createdAt) }}</BondText>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.media-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.media-panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.media-panel-badge {
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

.media-panel-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 0.5rem 0.75rem 2rem;
}

.media-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
}

.media-summary {
  padding-bottom: 0.5rem;
}

.media-grid {
  columns: 120px;
  column-gap: 0.375rem;
}

.media-item {
  break-inside: avoid;
  margin-bottom: 0.375rem;
  cursor: pointer;
}

.media-thumb {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
}

.media-thumb img {
  width: 100%;
  display: block;
}

.media-placeholder {
  width: 100%;
  height: 100%;
  background: var(--color-surface);
}

.media-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 0.375rem;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  color: rgba(255, 255, 255, 0.9);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.media-item:hover .media-meta {
  opacity: 1;
}
</style>
