<script setup lang="ts">
import { PhHouse } from '@phosphor-icons/vue'
import type { WpSiteMap, WpSiteMapNode } from '../../shared/wordpress'
import BondText from './BondText.vue'

defineProps<{
  siteMap: WpSiteMap
}>()
</script>

<template>
  <div class="site-map-view">
    <!-- Pages tree -->
    <div v-if="siteMap.pages.length" class="map-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Pages</BondText>
      <div class="tree">
        <div v-for="node in siteMap.pages" :key="node.id" class="tree-branch">
          <SiteMapNode :node="node" :homePageId="siteMap.homePageId" />
        </div>
      </div>
    </div>

    <!-- Posts (flat) -->
    <div v-if="siteMap.posts.length" class="map-section">
      <BondText as="h3" size="sm" weight="semibold" color="muted">Posts</BondText>
      <div class="post-list">
        <div v-for="node in siteMap.posts" :key="node.id" class="map-node">
          <BondText size="sm" weight="medium">{{ node.title || '(Untitled)' }}</BondText>
          <BondText size="xs" color="muted" mono>/{{ node.slug }}</BondText>
        </div>
      </div>
    </div>

    <div v-if="!siteMap.pages.length && !siteMap.posts.length" class="map-empty">
      <BondText size="sm" color="muted">No pages or posts found.</BondText>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, h } from 'vue'

const SiteMapNode = defineComponent({
  name: 'SiteMapNode',
  props: {
    node: { type: Object as () => WpSiteMapNode, required: true },
    homePageId: { type: [Number, null] as unknown as () => number | null, default: null }
  },
  render() {
    const node = this.node
    const isHome = this.homePageId != null && node.id === this.homePageId

    const label = h('div', { class: 'map-node' }, [
      h('div', { class: 'map-node-title' }, [
        isHome ? h(PhHouse, { size: 14, weight: 'bold', class: 'home-icon' }) : null,
        h(BondText, { size: 'sm', weight: 'medium' }, () => node.title || '(Untitled)')
      ]),
      h(BondText, { size: 'xs', color: 'muted', mono: true }, () => `/${node.slug}`)
    ])

    if (node.children.length === 0) return label

    const children = node.children.map(child =>
      h('div', { key: child.id, class: 'tree-branch' }, [
        h(SiteMapNode, { node: child, homePageId: this.homePageId })
      ])
    )

    return h('div', { class: 'tree-parent' }, [
      label,
      h('div', { class: 'tree-children' }, children)
    ])
  }
})
</script>

<style scoped>
.site-map-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.map-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.map-node {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.map-node-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.home-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.post-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* Tree layout */
.tree {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tree-parent {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tree-children {
  padding-left: 1.25rem;
  margin-left: 0.375rem;
  border-left: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tree-branch {
  display: flex;
  flex-direction: column;
}

.map-empty {
  padding: 0.5rem 0;
}
</style>
