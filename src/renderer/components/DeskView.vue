<script setup lang="ts">
/**
 * The Desk review panel — the fifth right panel.
 *
 * The notch panel is a HUD, and Apple's guidance on those is one line worth
 * obeying: *"Keep HUDs small. HUDs are designed to be unobtrusively useful."*
 * So the heavier work lives here instead: the day's blocks with their notes,
 * the thread catalogue with rename/merge/archive, and the buried rules editor.
 *
 * Same product rules as the notch. Desk describes; it never grades. No score,
 * no streak, no daily target, no comparison to yesterday. Time is always
 * approximate.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondSelect from './BondSelect.vue'
import BondTab from './BondTab.vue'
import BondText from './BondText.vue'
import { appColor } from '../composables/useSense'
import { formatApproxDuration } from '../../shared/desk'
import type { DeskBlockDetail, DeskMatcher, DeskStats, DeskStatus, DeskThread } from '../../shared/desk'

const tabs = [
  { id: 'day', label: 'Day' },
  { id: 'threads', label: 'Threads' },
  { id: 'rules', label: 'Rules' },
]
const tab = ref('day')

const status = ref<DeskStatus | null>(null)
const blocks = ref<DeskBlockDetail[]>([])
const threads = ref<DeskThread[]>([])
const matchers = ref<DeskMatcher[]>([])
const stats = ref<DeskStats | null>(null)
const loading = ref(false)

const newThreadName = ref('')
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const mergeSourceId = ref<string | null>(null)
const mergeTargetId = ref('')
const confirmingDelete = ref<string | null>(null)
const editingNoteId = ref<string | null>(null)
const noteValue = ref('')

const isDark = computed(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

/** Local start/end of today, as ISO instants. */
function todayRange(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return { from: from.toISOString(), to: to.toISOString() }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [s, b, t, m, st] = await Promise.all([
      window.bond.deskStatus(),
      window.bond.deskBlocks({ ...todayRange(), limit: 100 }),
      window.bond.deskThreads(true),
      window.bond.deskMatchers(false),
      window.bond.deskStats(24),
    ])
    status.value = s
    blocks.value = b
    threads.value = t
    matchers.value = m
    stats.value = st
  } finally {
    loading.value = false
  }
}

const namedBlocks = computed(() => blocks.value.filter(b => b.thread))
const activeThreads = computed(() => threads.value.filter(t => t.status !== 'archived'))
const archivedThreads = computed(() => threads.value.filter(t => t.status === 'archived'))

const threadOptions = computed(() =>
  activeThreads.value
    .filter(t => t.id !== mergeSourceId.value)
    .map(t => ({ value: t.id, label: t.name, color: appColor(t.id, isDark.value) }))
)

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// --- thread catalogue ---

async function createThread(): Promise<void> {
  const name = newThreadName.value.trim()
  if (!name) return
  newThreadName.value = ''
  await window.bond.deskCreateThread(name)
  await load()
}

function startRename(thread: DeskThread): void {
  renamingId.value = thread.id
  renameValue.value = thread.name
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  const name = renameValue.value.trim()
  renamingId.value = null
  if (!id || !name) return
  await window.bond.deskRenameThread(id, name)
  await load()
}

async function toggleArchive(thread: DeskThread): Promise<void> {
  await window.bond.deskArchiveThread(thread.id, thread.status !== 'archived')
  await load()
}

/** Merging is explicit and irreversible, so it takes two deliberate steps. */
async function commitMerge(): Promise<void> {
  const source = mergeSourceId.value
  const target = mergeTargetId.value
  mergeSourceId.value = null
  mergeTargetId.value = ''
  if (!source || !target) return
  await window.bond.deskMergeThreads(target, source)
  await load()
}

// --- notes ---

function startNote(block: DeskBlockDetail): void {
  editingNoteId.value = block.id
  noteValue.value = block.reentryNote ?? ''
}

async function commitNote(): Promise<void> {
  const id = editingNoteId.value
  editingNoteId.value = null
  if (!id) return
  await window.bond.deskUpdateNote(id, noteValue.value)
  await load()
}

// --- rules ---

async function disableMatcher(id: string): Promise<void> {
  await window.bond.deskDisableMatcher(id)
  await load()
}

async function deleteMatcher(id: string): Promise<void> {
  if (confirmingDelete.value !== id) { confirmingDelete.value = id; return }
  confirmingDelete.value = null
  await window.bond.deskDeleteMatcher(id)
  await load()
}

function threadName(id: string): string {
  return threads.value.find(t => t.id === id)?.name ?? 'unknown thread'
}

function describeMatcher(matcher: DeskMatcher): string {
  if (matcher.field === 'title') return `windows titled "${matcher.pattern}"`
  if (matcher.field === 'path') return `files under ${matcher.pattern}`
  if (matcher.field === 'bundle') return matcher.pattern
  return 'this exact resource'
}

// --- lifecycle ---

let offChanged: (() => void) | undefined

onMounted(() => {
  load()
  offChanged = window.bond.onDeskChanged(() => load())
})

onUnmounted(() => offChanged?.())
</script>

<template>
  <div class="desk-view">
    <header class="desk-view-head">
      <BondTab :tabs="tabs" v-model="tab" />
      <BondButton variant="ghost" size="sm" :disabled="loading" @click="load">Refresh</BondButton>
    </header>

    <!-- Day -->
    <div v-if="tab === 'day'" class="desk-view-body">
      <p v-if="status && !status.senseEnabled" class="desk-view-hint">
        Sense is off, so nothing new is being observed. Past threads still show.
      </p>
      <p v-else-if="status?.backfilling" class="desk-view-hint">Still catching up on today's captures.</p>

      <p v-if="namedBlocks.length === 0" class="desk-view-empty">
        Nothing observed today yet.
      </p>

      <article v-for="block in namedBlocks" :key="block.id" class="desk-block">
        <div class="desk-block-head">
          <span class="desk-block-mark" :style="{ background: appColor(block.thread!.id, isDark) }" />
          <BondText weight="medium" size="sm" truncate>{{ block.thread!.name }}</BondText>
          <BondText size="xs" color="muted" class="desk-block-when">
            {{ time(block.startedAt) }} · {{ formatApproxDuration(block.presenceSeconds) }}
          </BondText>
        </div>

        <div v-if="editingNoteId === block.id" class="desk-block-note-edit">
          <BondInput v-model="noteValue" placeholder="Where were you?" @keydown.enter="commitNote" />
          <BondButton variant="secondary" size="sm" @click="commitNote">Save</BondButton>
        </div>
        <button v-else type="button" class="desk-block-note" @click="startNote(block)">
          <BondText v-if="block.reentryNote" size="xs" color="muted">{{ block.reentryNote }}</BondText>
          <BondText v-else-if="block.noteStatus === 'pending'" size="xs" color="muted">writing a note…</BondText>
          <BondText v-else size="xs" color="muted" class="desk-faint">Add a re-entry note</BondText>
        </button>
      </article>

      <footer v-if="stats" class="desk-view-foot">
        <BondText size="xs" color="muted">
          {{ stats.blocks }} blocks · {{ stats.threads }} threads ·
          {{ Math.round(stats.cacheHitRate * 100) }}% resolved without a model call
        </BondText>
      </footer>
    </div>

    <!-- Threads -->
    <div v-else-if="tab === 'threads'" class="desk-view-body">
      <div class="desk-new-thread">
        <BondInput v-model="newThreadName" placeholder="New thread…" @keydown.enter="createThread" />
        <BondButton variant="secondary" size="sm" :disabled="!newThreadName.trim()" @click="createThread">
          Add
        </BondButton>
      </div>

      <article v-for="thread in activeThreads" :key="thread.id" class="desk-thread">
        <div class="desk-thread-head">
          <span class="desk-block-mark" :style="{ background: appColor(thread.id, isDark) }" />
          <BondInput
            v-if="renamingId === thread.id"
            v-model="renameValue"
            @keydown.enter="commitRename"
            @blur="commitRename"
          />
          <BondText v-else weight="medium" size="sm" truncate>{{ thread.name }}</BondText>
          <BondText size="xs" color="muted">{{ thread.status }}</BondText>
        </div>

        <BondText v-if="thread.userNote" size="xs" color="muted">{{ thread.userNote }}</BondText>

        <div class="desk-thread-actions">
          <BondButton variant="ghost" size="sm" @click="startRename(thread)">Rename</BondButton>
          <BondButton variant="ghost" size="sm" @click="mergeSourceId = thread.id">Merge into…</BondButton>
          <BondButton variant="ghost" size="sm" @click="toggleArchive(thread)">Archive</BondButton>
        </div>

        <div v-if="mergeSourceId === thread.id" class="desk-merge">
          <BondSelect v-model="mergeTargetId" :options="threadOptions" size="sm" />
          <BondButton variant="danger" size="sm" :disabled="!mergeTargetId" @click="commitMerge">
            Merge
          </BondButton>
          <BondButton variant="ghost" size="sm" @click="mergeSourceId = null">Cancel</BondButton>
        </div>
      </article>

      <template v-if="archivedThreads.length">
        <BondText as="h3" size="xs" color="muted" class="desk-subhead">Archived</BondText>
        <article v-for="thread in archivedThreads" :key="thread.id" class="desk-thread is-archived">
          <div class="desk-thread-head">
            <BondText size="sm" color="muted" truncate>{{ thread.name }}</BondText>
            <BondButton variant="ghost" size="sm" @click="toggleArchive(thread)">Restore</BondButton>
          </div>
        </article>
      </template>
    </div>

    <!-- Rules -->
    <div v-else class="desk-view-body">
      <p class="desk-view-hint">
        Rules Bond learned from your corrections. Confirmed rules came from you;
        the rest are guesses it will drop on its own.
      </p>

      <p v-if="matchers.length === 0" class="desk-view-empty">No rules yet.</p>

      <article v-for="matcher in matchers" :key="matcher.id" class="desk-rule" :class="{ 'is-off': !matcher.enabled }">
        <BondText size="sm">
          {{ describeMatcher(matcher) }} &rarr; {{ threadName(matcher.threadId) }}
        </BondText>
        <BondText size="xs" color="muted">
          {{ matcher.confirmed ? 'confirmed' : 'inferred' }} · {{ matcher.hits }} hits
          <template v-if="matcher.example.titles?.length"> · e.g. {{ matcher.example.titles[0] }}</template>
        </BondText>
        <div class="desk-thread-actions">
          <BondButton v-if="matcher.enabled" variant="ghost" size="sm" @click="disableMatcher(matcher.id)">
            Disable
          </BondButton>
          <BondButton variant="ghost" size="sm" @click="deleteMatcher(matcher.id)">
            {{ confirmingDelete === matcher.id ? 'Really delete?' : 'Delete' }}
          </BondButton>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.desk-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.desk-view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}

.desk-view-body {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.desk-view-hint,
.desk-view-empty {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-muted);
}

.desk-block,
.desk-thread,
.desk-rule {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.desk-block-head,
.desk-thread-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.desk-block-when { margin-left: auto; flex-shrink: 0; }

.desk-block-mark {
  flex-shrink: 0;
  width: 3px;
  height: 14px;
  border-radius: 999px;
}

.desk-block-note {
  text-align: left;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: text;
}

.desk-block-note-edit,
.desk-new-thread,
.desk-merge {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.desk-faint { opacity: 0.5; }

.desk-thread-actions {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.desk-thread.is-archived,
.desk-rule.is-off { opacity: 0.55; }

.desk-subhead {
  margin: 0.5rem 0 0;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.desk-view-foot {
  margin-top: auto;
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-border);
}
</style>
