<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  PhArchive, PhArrowLineUp, PhTrash,
  PhArrowLeft, PhDotsThree, PhListBullets
} from '@phosphor-icons/vue'
import type { Collection, FieldDef } from '../../shared/session'
import BondText from './BondText.vue'
import BondButton from './BondButton.vue'
import BondFlyoutMenu from './BondFlyoutMenu.vue'
import BondToolbar from './BondToolbar.vue'
import CollectionDetail from './CollectionDetail.vue'

const props = defineProps<{
  collections: Collection[]
  archivedCollections: Collection[]
  activeCollectionId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
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
  <div class="collections-panel">
    <!-- Collection detail -->
    <template v-if="activeCollection">
      <BondToolbar label="Collection detail" drag blur class="collections-panel-toolbar">
        <template #start>
          <BondButton variant="ghost" size="sm" icon @click="emit('back')" v-tooltip="'Back to collections'">
            <PhArrowLeft :size="14" weight="bold" />
          </BondButton>
          <BondText size="sm" weight="medium" truncate>
            {{ activeCollection.icon ? activeCollection.icon + ' ' : '' }}{{ activeCollection.name }}
          </BondText>
        </template>
        <template #end>
          <BondButton ref="menuBtnRef" variant="ghost" size="sm" icon @click="menuOpen = !menuOpen" v-tooltip="'More'">
            <PhDotsThree :size="14" weight="bold" />
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
      </BondToolbar>
      <div class="collections-panel-scroll">
        <CollectionDetail :collection="activeCollection" />
      </div>
    </template>

    <!-- Collection list -->
    <template v-else>
      <BondToolbar label="Collections" drag blur class="collections-panel-toolbar">
        <template #start>
          <BondText size="sm" weight="medium" color="muted">Collections</BondText>
          <span v-if="collections.length" class="collections-panel-badge">{{ collections.length }}</span>
        </template>
        <template #end>
          <BondButton ref="archiveBtnRef" variant="ghost" size="sm" icon @click="archiveFlyoutOpen = !archiveFlyoutOpen" v-tooltip="'Archived collections'">
            <PhArchive :size="14" weight="bold" />
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
        </template>
      </BondToolbar>

      <div class="collections-panel-scroll">
        <div class="collections-panel-body">
          <div v-if="collections.length === 0" class="collections-panel-empty">
            <BondText size="sm" color="muted">No collections yet.</BondText>
            <BondText size="xs" color="muted">Ask Bond to create one.</BondText>
          </div>

          <nav v-else class="collections-panel-list">
            <button
              v-for="c in collections"
              :key="c.id"
              class="collections-panel-item"
              @click="emit('select', c.id)"
            >
              <div class="collections-panel-item-icon">
                <span v-if="c.icon" class="item-emoji">{{ c.icon }}</span>
                <PhListBullets v-else :size="14" weight="bold" />
              </div>
              <div class="collections-panel-item-body">
                <BondText size="sm">{{ c.name }}</BondText>
                <BondText size="xs" color="muted">{{ c.schema.length }} fields</BondText>
              </div>
            </button>
          </nav>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.collections-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
}

.collections-panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.collections-panel-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.collections-panel-badge {
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

.collections-panel-body {
  padding: 0.5rem;
}

.collections-panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 3rem 1rem;
  text-align: center;
}

.collections-panel-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.collections-panel-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: var(--radius-md);
  text-align: left;
  width: 100%;
  transition: background var(--transition-fast);
}
.collections-panel-item:hover {
  background: var(--color-tint);
}

.collections-panel-item-icon {
  width: 1.75rem;
  height: 1.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-tint);
  border-radius: var(--radius-md);
  color: var(--color-muted);
  flex-shrink: 0;
}

.item-emoji {
  font-size: 1rem;
  line-height: 1;
}

.collections-panel-item-body {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
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
