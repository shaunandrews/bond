<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { ImageRecord, AttachedImage } from '../../../shared/session'
import { imageDataUri } from '../../../shared/session'

const props = defineProps<{
  ids?: string        // comma-separated image IDs — show specific images
  search?: string     // filter by filename
  limit?: string
}>()

const records = ref<ImageRecord[]>([])
const imageData = ref(new Map<string, AttachedImage>())
const loading = ref(true)

const idSet = computed(() => {
  if (!props.ids) return null
  return props.ids.split(',').map(s => s.trim()).filter(Boolean)
})

const maxItems = computed(() => {
  const n = parseInt(props.limit ?? '12', 10)
  return isNaN(n) ? 12 : n
})

const filtered = computed(() => {
  if (idSet.value) {
    const map = new Map(records.value.map(r => [r.id, r]))
    return idSet.value.map(id => map.get(id)).filter(Boolean) as ImageRecord[]
  }

  let list = records.value

  if (props.search) {
    const q = props.search.toLowerCase()
    list = list.filter(r => r.filename.toLowerCase().includes(q))
  }

  return list.slice(0, maxItems.value)
})

onMounted(async () => {
  try {
    const list = await window.bond.listImages()
    records.value = list

    let toLoad: string[]
    if (idSet.value) {
      toLoad = idSet.value
    } else {
      toLoad = list.slice(0, maxItems.value).map(r => r.id)
    }

    if (toLoad.length > 0) {
      const images = await window.bond.getImages(toLoad)
      for (let i = 0; i < toLoad.length; i++) {
        if (images[i]) imageData.value.set(toLoad[i], images[i])
      }
    }
  } finally {
    loading.value = false
  }
})

function getSrc(id: string): string | null {
  const img = imageData.value.get(id)
  return img ? imageDataUri(img) : null
}

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
</script>

<template>
  <div class="media-embed">
    <div v-if="loading" class="embed-loading">Loading images...</div>
    <div v-else-if="filtered.length === 0" class="embed-empty">No images found</div>
    <div v-else class="media-grid" :class="{ 'media-grid--single': filtered.length === 1 }">
      <div
        v-for="rec in filtered"
        :key="rec.id"
        class="media-thumb"
        @dblclick="openImage(rec)"
      >
        <img v-if="getSrc(rec.id)" :src="getSrc(rec.id)!" class="thumb-img" />
        <div class="thumb-meta">{{ rec.filename }}</div>
      </div>
    </div>
    <div v-if="!idSet && records.length > maxItems" class="media-overflow">
      +{{ records.length - maxItems }} more
    </div>
  </div>
</template>

<style scoped>
.media-embed {
  padding: 0.5em 0;
}

.embed-loading, .embed-empty {
  font-size: 0.8em;
  color: var(--color-muted);
  padding: 0.25em 0;
}

.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 0.4em;
}

.media-grid--single {
  grid-template-columns: 1fr;
  max-width: 400px;
}

.media-thumb {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  cursor: zoom-in;
}

.media-grid:not(.media-grid--single) .media-thumb {
  aspect-ratio: 1;
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-grid--single .thumb-img {
  object-fit: contain;
  height: auto;
}

.thumb-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0.2em 0.4em;
  font-size: 0.65em;
  color: white;
  background: linear-gradient(transparent, rgba(0,0,0,0.6));
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.media-overflow {
  font-size: 0.75em;
  color: var(--color-muted);
  text-align: center;
  margin-top: 0.3em;
}
</style>
