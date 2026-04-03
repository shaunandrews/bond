<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  PhPlus, PhArchive, PhArrowLineUp, PhTrash,
  PhArrowLeft, PhDotsThree, PhListBullets
} from '@phosphor-icons/vue'
import type { Collection, FieldDef } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import ViewShell from './ViewShell.vue'
import CollectionDetail from './CollectionDetail.vue'

const props = defineProps<{
  collections: Collection[]
  archivedCollections: Collection[]
  activeCollectionId: string | null
  insetStart?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  create: [name: string, schema: FieldDef[], icon: string]
  archive: [id: string]
  unarchive: [id: string]
  remove: [id: string]
  back: []
}>()

// Archive flyout
const archiveFlyoutOpen = ref(false)
const archiveBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

// Menu flyout
const menuOpen = ref(false)
const menuBtnRef = ref<InstanceType<typeof BondButton> | null>(null)

const activeCollection = computed(() =>
  props.collections.find(c => c.id === props.activeCollectionId) ?? null
)

function handleArchiveSelect(id: string) {
  emit('select', id)
  archiveFlyoutOpen.value = false
}
</script>

<template>
  <!-- Collection detail -->
  <ViewShell
    v-if="activeCollection"
    :title="`${activeCollection.icon ? activeCollection.icon + ' ' : ''}${activeCollection.name}`"
    :insetStart="insetStart"
  >
    <template #header-start>
      <BondButton variant="ghost" size="sm" icon @click="emit('back')" v-tooltip="'Back to collections'">
        <PhArrowLeft :size="16" weight="bold" />
      </BondButton>
    </template>
    <template #header-end>
      <BondButton ref="menuBtnRef" variant="ghost" size="sm" icon @click="menuOpen = !menuOpen" v-tooltip="'More'">
        <PhDotsThree :size="16" weight="bold" />
      </BondButton>
      <BondFlyoutMenu :open="menuOpen" :anchor="menuBtnRef?.$el" :width="160" @close="menuOpen = false">
        <nav class="collection-menu">
          <button class="collection-menu-item" @click="emit('archive', activeCollection!.id); menuOpen = false">
            <PhArchive :size="14" weight="bold" />
            <span>Archive</span>
          </button>
          <button class="collection-menu-item collection-menu-item--danger" @click="emit('remove', activeCollection!.id); menuOpen = false">
            <PhTrash :size="14" weight="bold" />
            <span>Delete</span>
          </button>
        </nav>
      </BondFlyoutMenu>
    </template>

    <CollectionDetail :collection="activeCollection" />
  </ViewShell>

  <!-- Collection list -->
  <ViewShell
    v-else
    title="Collections"
    :insetStart="insetStart"
  >
    <template #header-start>
      <slot name="header-start" />
    </template>
    <template #header-end>
      <BondButton ref="archiveBtnRef" variant="ghost" size="sm" icon @click="archiveFlyoutOpen = !archiveFlyoutOpen" v-tooltip="'Archived collections'">
        <PhArchive :size="16" weight="bold" />
      </BondButton>
      <BondFlyoutMenu :open="archiveFlyoutOpen" :anchor="archiveBtnRef?.$el" :width="260" @close="archiveFlyoutOpen = false">
        <BondText as="div" size="xs" weight="medium" color="muted" class="pt-2 px-3 pb-1 shrink-0">
          Archived ({{ archivedCollections.length }})
        </BondText>
        <nav v-if="archivedCollections.length" class="archive-list">
          <button v-for="c in archivedCollections" :key="c.id" class="archive-item" @click="handleArchiveSelect(c.id)">
            <span v-if="c.icon" class="archive-icon">{{ c.icon }}</span>
            <PhListBullets v-else :size="14" weight="bold" />
            <span class="archive-item-name">{{ c.name }}</span>
            <BondButton variant="ghost" size="sm" icon @click.stop="emit('unarchive', c.id)" v-tooltip="'Unarchive'">
              <PhArrowLineUp :size="14" weight="bold" />
            </BondButton>
          </button>
        </nav>
        <BondText v-else as="p" size="sm" color="muted" class="p-3 text-center">No archived collections</BondText>
      </BondFlyoutMenu>
      <slot name="header-end" />
    </template>

    <div class="collection-list-wrap">
      <div v-if="collections.length === 0" class="collection-list-empty">
        <BondText size="sm" color="muted">No collections yet.</BondText>
        <BondText size="xs" color="muted">Ask Bond to create one, or use the CLI:</BondText>
        <BondText size="xs" color="muted" mono>bond collection create Movies --icon 🎬 --schema '[...]'</BondText>
      </div>

      <div v-else class="collection-grid">
        <button
          v-for="c in collections"
          :key="c.id"
          class="collection-card"
          @click="emit('select', c.id)"
        >
          <div class="collection-card-icon">
            <span v-if="c.icon" class="card-emoji">{{ c.icon }}</span>
            <PhListBullets v-else :size="20" weight="bold" />
          </div>
          <div class="collection-card-body">
            <BondText size="sm" weight="medium">{{ c.name }}</BondText>
            <BondText size="xs" color="muted">{{ c.schema.length }} fields</BondText>
          </div>
        </button>
      </div>
    </div>
  </ViewShell>
</template>

<style scoped>
.collection-list-wrap {
  padding: 1rem 1.5rem 2rem;
}

.collection-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 4rem 1rem;
  text-align: center;
}

.collection-grid {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.collection-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: var(--radius-md);
  text-align: left;
  transition: background var(--transition-fast);
  width: 100%;
}
.collection-card:hover {
  background: var(--color-tint);
}

.collection-card-icon {
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-tint);
  border-radius: var(--radius-md);
  color: var(--color-muted);
  flex-shrink: 0;
}

.card-emoji {
  font-size: 1.1rem;
  line-height: 1;
}

.collection-card-body {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

/* Archive flyout */
.archive-list {
  display: flex;
  flex-direction: column;
  max-height: 200px;
  overflow-y: auto;
}

.archive-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  text-align: left;
  transition: background var(--transition-fast);
}
.archive-item:hover {
  background: var(--color-tint);
}

.archive-icon {
  font-size: 0.9rem;
}

.archive-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Menu */
.collection-menu {
  display: flex;
  flex-direction: column;
  padding: 0.25rem;
}

.collection-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}
.collection-menu-item:hover {
  background: var(--color-tint);
}

.collection-menu-item--danger {
  color: var(--color-err);
}
</style>
