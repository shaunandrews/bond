<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { CollectionItem } from '../../../shared/session'
import { getEntryTitle, getEntryBody, getEntryAuthor, getEntryTags, getEntryPinned } from '../../composables/useJournal'
import { PhRobot, PhUser, PhPushPin } from '@phosphor-icons/vue'
import BondText from '../BondText.vue'
import MarkdownMessage from '../MarkdownMessage.vue'

const props = defineProps<{
  ids?: string        // comma-separated entry IDs
  author?: string     // filter by author ('user' or 'bond')
  project?: string    // filter by project name
  search?: string     // search query
  limit?: string
}>()

const entries = ref<CollectionItem[]>([])
const loading = ref(true)

const maxItems = computed(() => {
  const n = parseInt(props.limit ?? '10', 10)
  return isNaN(n) ? 10 : n
})

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

onMounted(async () => {
  try {
    if (props.ids) {
      const idList = props.ids.split(',').map(s => s.trim()).filter(Boolean)
      const results = await Promise.all(idList.map(id => window.bond.getJournalEntry(id)))
      entries.value = results.filter(Boolean) as CollectionItem[]
    } else if (props.search) {
      entries.value = await window.bond.searchJournalEntries(props.search)
      entries.value = entries.value.slice(0, maxItems.value)
    } else {
      const opts: Record<string, unknown> = { limit: maxItems.value }
      if (props.author) opts.author = props.author
      // Resolve project name to ID if provided
      if (props.project) {
        const projects = await window.bond.listProjects()
        const match = projects.find(p => p.name.toLowerCase() === props.project!.toLowerCase())
        if (match) opts.projectId = match.id
      }
      entries.value = await window.bond.listJournalEntries(opts as any)
    }
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="journal-embed">
    <div v-if="loading" class="journal-embed-empty">
      <BondText size="xs" color="muted">Loading journal...</BondText>
    </div>
    <div v-else-if="entries.length === 0" class="journal-embed-empty">
      <BondText size="xs" color="muted">No journal entries found.</BondText>
    </div>
    <div v-else class="journal-embed-list">
      <div v-for="entry in entries" :key="entry.id" class="journal-embed-entry">
        <div class="journal-embed-header">
          <span class="author-badge" :class="getEntryAuthor(entry)">
            <PhRobot v-if="getEntryAuthor(entry) === 'bond'" :size="10" />
            <PhUser v-else :size="10" />
            {{ getEntryAuthor(entry) === 'bond' ? 'Bond' : 'You' }}
          </span>
          <BondText size="sm" weight="medium" class="flex-1 min-w-0">{{ getEntryTitle(entry) }}</BondText>
          <PhPushPin v-if="getEntryPinned(entry)" :size="12" weight="fill" class="pin-icon" />
          <BondText size="xs" color="muted" class="shrink-0">{{ formatDate(entry.createdAt) }}</BondText>
        </div>
        <div class="journal-embed-body">
          <MarkdownMessage :text="getEntryBody(entry)" :streaming="false" />
        </div>
        <div v-if="getEntryTags(entry).length" class="journal-embed-tags">
          <span v-for="tag in getEntryTags(entry)" :key="tag" class="embed-tag">{{ tag }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.journal-embed {
  margin: 0.5em 0;
}

.journal-embed-empty {
  padding: 0.75rem;
  text-align: center;
}

.journal-embed-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.journal-embed-entry {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.journal-embed-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.author-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.125rem 0.3125rem;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.author-badge.bond {
  background: var(--color-accent);
  color: var(--color-bg);
}
.author-badge.user {
  background: var(--color-border);
  color: var(--color-text-primary);
}

.pin-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.journal-embed-body {
  font-size: 0.875rem;
  line-height: 1.5;
}

.journal-embed-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.embed-tag {
  font-size: 0.625rem;
  padding: 0.0625rem 0.3125rem;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  color: var(--color-muted);
}
</style>
