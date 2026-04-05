<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useBrowser } from '../composables/useBrowser'
import type { ConsoleEntry, NetworkEntry } from '../../shared/browser'
import BondText from './BondText.vue'
import BondTab from './BondTab.vue'
import { PhWarning, PhXCircle, PhInfo } from '@phosphor-icons/vue'

const browser = useBrowser()

const activePanel = ref('console')
const panels = [
  { id: 'console', label: 'Console' },
  { id: 'network', label: 'Network' },
]

const consoleFilter = ref<string>('all')
const jsInput = ref('')
const consoleScrollRef = ref<HTMLElement | null>(null)

const consoleEntries = computed<ConsoleEntry[]>(() => {
  const log = browser.getConsoleLog()
  if (consoleFilter.value === 'all') return log
  return log.filter(e => e.level === consoleFilter.value)
})

const networkEntries = computed<NetworkEntry[]>(() => browser.getNetworkLog())

// Auto-scroll console
watch(
  () => consoleEntries.value.length,
  () => {
    nextTick(() => {
      if (consoleScrollRef.value) {
        consoleScrollRef.value.scrollTop = consoleScrollRef.value.scrollHeight
      }
    })
  }
)

function levelIcon(level: ConsoleEntry['level']) {
  switch (level) {
    case 'warn': return PhWarning
    case 'error': return PhXCircle
    case 'info': return PhInfo
    default: return null
  }
}

function levelColor(level: ConsoleEntry['level']) {
  switch (level) {
    case 'warn': return 'color: #e6a23c'
    case 'error': return 'color: var(--color-err)'
    case 'info': return 'color: var(--color-accent)'
    default: return ''
  }
}

function statusColor(status: number | null): string {
  if (status == null) return 'color: var(--color-muted)'
  if (status >= 200 && status < 300) return 'color: var(--color-ok)'
  if (status >= 300 && status < 400) return 'color: var(--color-accent)'
  if (status >= 400) return 'color: var(--color-err)'
  return ''
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

async function execJs() {
  const code = jsInput.value.trim()
  if (!code) return
  jsInput.value = ''

  // Add input as a log entry
  browser.addConsoleEntry(browser.activeTabId.value ?? '', {
    level: 'info',
    text: `> ${code}`,
    args: [code],
    timestamp: Date.now(),
  })

  // Execute in webview via IPC
  if (window.bond.browser) {
    try {
      const result = await window.bond.browser.execInTab(browser.activeTabId.value ?? '', code)
      browser.addConsoleEntry(browser.activeTabId.value ?? '', {
        level: 'log',
        text: String(result),
        args: [String(result)],
        timestamp: Date.now(),
      })
    } catch (e: any) {
      browser.addConsoleEntry(browser.activeTabId.value ?? '', {
        level: 'error',
        text: e.message,
        args: [e.message],
        timestamp: Date.now(),
      })
    }
  }
}
</script>

<template>
  <div class="devtools">
    <div class="devtools-header">
      <BondTab :tabs="panels" v-model="activePanel" />
      <div v-if="activePanel === 'console'" class="devtools-filters">
        <button
          v-for="f in ['all', 'error', 'warn', 'log']"
          :key="f"
          :class="['devtools-filter', { 'devtools-filter--active': consoleFilter === f }]"
          @click="consoleFilter = f"
        >{{ f }}</button>
      </div>
    </div>

    <!-- Console panel -->
    <div v-if="activePanel === 'console'" class="devtools-body">
      <div ref="consoleScrollRef" class="devtools-console-scroll">
        <div v-if="consoleEntries.length === 0" class="devtools-empty">
          <BondText size="xs" color="muted">No console output</BondText>
        </div>
        <div
          v-for="(entry, i) in consoleEntries"
          :key="i"
          :class="['devtools-console-entry', `devtools-console-entry--${entry.level}`]"
        >
          <component :is="levelIcon(entry.level)" v-if="levelIcon(entry.level)" :size="12" :style="levelColor(entry.level)" />
          <span class="devtools-console-text" :style="levelColor(entry.level)">{{ entry.text }}</span>
          <span v-if="entry.source" class="devtools-console-source">{{ entry.source }}</span>
        </div>
      </div>
      <form class="devtools-console-input" @submit.prevent="execJs">
        <span class="devtools-console-prompt">&gt;</span>
        <input
          v-model="jsInput"
          type="text"
          placeholder="Evaluate JavaScript..."
          spellcheck="false"
          autocomplete="off"
        />
      </form>
    </div>

    <!-- Network panel -->
    <div v-else-if="activePanel === 'network'" class="devtools-body">
      <div class="devtools-network-scroll">
        <div v-if="networkEntries.length === 0" class="devtools-empty">
          <BondText size="xs" color="muted">No network requests</BondText>
        </div>
        <table v-else class="devtools-network-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>URL</th>
              <th>Status</th>
              <th>Type</th>
              <th>Size</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in networkEntries" :key="entry.requestId">
              <td class="devtools-network-method">{{ entry.method }}</td>
              <td class="devtools-network-url" :title="entry.url">{{ entry.url.split('?')[0].split('/').pop() || entry.url }}</td>
              <td :style="statusColor(entry.status)">{{ entry.status ?? '...' }}</td>
              <td>{{ entry.mimeType?.split('/').pop() ?? '-' }}</td>
              <td>{{ formatSize(entry.size) }}</td>
              <td>{{ formatTime(entry.timing) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style>
.devtools {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  overflow: hidden;
}

.devtools-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.devtools-filters {
  display: flex;
  gap: 2px;
  margin-left: auto;
}

.devtools-filter {
  all: unset;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  cursor: pointer;
  text-transform: capitalize;
}

.devtools-filter:hover {
  background: var(--color-tint);
}

.devtools-filter--active {
  color: var(--color-text-primary);
  background: var(--color-tint);
}

.devtools-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.devtools-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 1rem;
}

/* Console */
.devtools-console-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.devtools-console-entry {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 30%, transparent);
}

.devtools-console-entry--warn {
  background: color-mix(in srgb, #e6a23c 5%, transparent);
}

.devtools-console-entry--error {
  background: color-mix(in srgb, var(--color-err) 5%, transparent);
}

.devtools-console-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.devtools-console-source {
  color: var(--color-muted);
  font-size: 10px;
  white-space: nowrap;
  flex-shrink: 0;
}

.devtools-console-input {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.devtools-console-prompt {
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 11px;
  flex-shrink: 0;
}

.devtools-console-input input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  outline: none;
}

/* Network */
.devtools-network-scroll {
  flex: 1;
  overflow: auto;
}

.devtools-network-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 11px;
}

.devtools-network-table th {
  position: sticky;
  top: 0;
  background: var(--color-bg);
  text-align: left;
  font-weight: 600;
  padding: 3px 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.devtools-network-table td {
  padding: 3px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 30%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.devtools-network-method {
  font-weight: 600;
  color: var(--color-accent);
}

.devtools-network-url {
  color: var(--color-text-primary);
}
</style>
