<script setup lang="ts">
/**
 * MCP connections — the Settings section for adding, trusting, and diagnosing
 * Model Context Protocol servers.
 *
 * Config and live connection state come from two different daemon calls
 * (mcp.list is what's saved, mcp.status is what's running) and are joined per
 * row here. Expanding a row loads that server's catalog so each tool can be
 * classified, pinned, or forced to always ask — the same policy the daemon
 * gate reads, never a second copy of the rules.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PhArrowClockwise, PhCaretRight, PhKey, PhPushPin, PhTrash } from '@phosphor-icons/vue'
import type {
  McpPolicyWire,
  McpServerConfigWire,
  McpServerPresetWire,
  McpServerStatusWire,
  McpToolInfoWire,
} from '../../shared/rpc-schema'
import { parseToolDescription, type CatalogEntry, type ParsedToolDescription } from '../lib/toolCatalog'
import BondButton from './BondButton.vue'
import BondInput from './BondInput.vue'
import BondSelect from './BondSelect.vue'
import BondTab from './BondTab.vue'
import BondText from './BondText.vue'
import BondTextarea from './BondTextarea.vue'

const servers = ref<McpServerConfigWire[]>([])
const presets = ref<McpServerPresetWire[]>([])
const statuses = ref<McpServerStatusWire[]>([])
const toolsByServer = ref<Record<string, McpToolInfoWire[]>>({})
const toolErrors = ref<Record<string, string>>({})
const expandedId = ref('')
const loadingToolsId = ref('')
const error = ref('')
const busyId = ref('')
const showJsonForm = ref(false)
const jsonDraft = ref('')
const confirmRemoveId = ref('')
const tokenDraftId = ref('')
const tokenDraft = ref('')
const openEntryKey = ref('')

const STATE_LABELS: Record<McpServerStatusWire['state'], string> = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'idle',
  disabled: 'off',
  error: 'error',
}

const TRUST_OPTIONS = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'trusted', label: 'Trusted' },
  { value: 'disabled', label: 'Never run' },
]

/**
 * One control, three states, in the order they escalate. "Ask" is the
 * unclassified default — decideMcpCall prompts for anything it can't place,
 * so the honest label for that state is what it does, not what it lacks.
 */
const PERMISSION_TABS = [
  { id: 'unknown', label: 'Ask' },
  { id: 'read', label: 'Read' },
  { id: 'write', label: 'Write' },
]

const unusedPresets = computed(() =>
  presets.value.filter((preset) => !servers.value.some((server) => server.id === preset.id)))

/** Parsed descriptions are pure and re-render often — parse each one once. */
const catalogCache = new Map<string, ParsedToolDescription>()

function catalogOf(tool: McpToolInfoWire): ParsedToolDescription {
  const key = `${tool.server}:${tool.name}:${tool.description.length}`
  let parsed = catalogCache.get(key)
  if (!parsed) {
    parsed = parseToolDescription(tool.description)
    catalogCache.set(key, parsed)
  }
  return parsed
}

/**
 * What a proxy tool can reach. The daemon's route options are authoritative
 * (they come from the schema); the parsed description fills in when a server
 * documents its providers in prose but doesn't enumerate them.
 */
function reachOf(tool: McpToolInfoWire): string[] {
  if (tool.route?.options.length) return tool.route.options
  return catalogOf(tool).entries.map((entry) => entry.name)
}

/** "providers" reads better than "options" when the schema names the segment. */
function routeNoun(tool: McpToolInfoWire): string {
  const segment = tool.route?.segments[0]
  if (!segment) return 'entries'
  return segment.endsWith('s') ? segment : `${segment}s`
}

function routeClassOf(tool: McpToolInfoWire, route: string): 'read' | 'write' | 'unknown' {
  return tool.route?.classes[route] ?? 'unknown'
}

function entryText(tool: McpToolInfoWire, route: string): string {
  return catalogOf(tool).entries.find((entry) => entry.name === route)?.description ?? ''
}

function toggleEntry(tool: McpToolInfoWire, route: string): void {
  const key = `${tool.name}:${route}`
  openEntryKey.value = openEntryKey.value === key ? '' : key
}

/** The route whose detail panel is open on this tool, if any. */
function openRoute(tool: McpToolInfoWire): string | undefined {
  const prefix = `${tool.name}:`
  return openEntryKey.value.startsWith(prefix) ? openEntryKey.value.slice(prefix.length) : undefined
}

/** Rules are stored scoped: `execute-tool:linear` beats a blanket tool rule. */
function classifyRoute(server: McpServerConfigWire, tool: McpToolInfoWire, route: string, toolClass: string): void {
  void run(server.id, async () => {
    await window.bond.mcpClassifyTool(server.id, `${tool.name}:${route}`, toolClass as 'read' | 'write' | 'unknown')
    await loadTools(server.id)
  })
}

/** True once any rule exists — the point at which "trust is off" starts mattering. */
function hasClassifiedTools(server: McpServerConfigWire): boolean {
  return server.policy.read.length > 0 || server.policy.write.length > 0
}

function statusFor(id: string): McpServerStatusWire | undefined {
  return statuses.value.find((status) => status.id === id)
}

function stateOf(server: McpServerConfigWire): McpServerStatusWire['state'] {
  return statusFor(server.id)?.state ?? (server.enabled ? 'disconnected' : 'disabled')
}

function endpointOf(server: McpServerConfigWire): string {
  return server.transport === 'http' ? (server.url ?? '') : `${server.command} ${server.args.join(' ')}`.trim()
}

/** Plain-language summary of what this server's policy means right now. */
function trustHint(policy: McpPolicyWire): string {
  if (policy.trust === 'disabled') return 'Bond will not run any tool from this server.'
  if (policy.trust === 'ask') return 'Every call asks you first.'
  const reads = policy.read.length
  return reads
    ? `${reads} read-only ${reads === 1 ? 'rule runs' : 'rules run'} without asking. Writes and anything unclassified still ask.`
    : 'Nothing runs unasked yet — mark something Read below.'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function load(): Promise<void> {
  try {
    const [list, status] = await Promise.all([window.bond.mcpList(), window.bond.mcpStatus()])
    servers.value = list.servers
    presets.value = list.presets
    statuses.value = status.servers
  } catch (err) {
    error.value = message(err)
  }
}

/** Every mutation funnels through here so one failure can't leave a stuck row. */
async function run(id: string, action: () => Promise<unknown>): Promise<void> {
  busyId.value = id
  error.value = ''
  try {
    await action()
    await load()
  } catch (err) {
    error.value = message(err)
  } finally {
    busyId.value = ''
  }
}

async function loadTools(id: string): Promise<void> {
  loadingToolsId.value = id
  delete toolErrors.value[id]
  try {
    const result = await window.bond.mcpListTools(id)
    toolsByServer.value = { ...toolsByServer.value, [id]: result.tools }
    const failure = result.errors.find((entry) => entry.server === id)
    if (failure) toolErrors.value = { ...toolErrors.value, [id]: failure.error }
  } catch (err) {
    toolErrors.value = { ...toolErrors.value, [id]: message(err) }
  } finally {
    loadingToolsId.value = ''
  }
}

function toggleExpanded(server: McpServerConfigWire): void {
  if (expandedId.value === server.id) {
    expandedId.value = ''
    return
  }
  expandedId.value = server.id
  // Connects the server on demand — that's the point of opening the row.
  if (!toolsByServer.value[server.id]) void loadTools(server.id)
}

function toggle(server: McpServerConfigWire): void {
  void run(server.id, () => window.bond.mcpUpdate(server.id, { enabled: !server.enabled }))
}

function reconnect(server: McpServerConfigWire): void {
  void run(server.id, async () => {
    await window.bond.mcpReconnect(server.id)
    delete toolsByServer.value[server.id]
    if (expandedId.value === server.id) await loadTools(server.id)
  })
}

function remove(server: McpServerConfigWire): void {
  if (confirmRemoveId.value !== server.id) {
    confirmRemoveId.value = server.id
    return
  }
  confirmRemoveId.value = ''
  void run(server.id, () => window.bond.mcpRemove(server.id))
}

function setTrust(server: McpServerConfigWire, trust: string): void {
  void run(server.id, () => window.bond.mcpSetTrust(server.id, trust as McpPolicyWire['trust']))
}

function classify(server: McpServerConfigWire, tool: McpToolInfoWire, toolClass: string): void {
  void run(server.id, async () => {
    await window.bond.mcpClassifyTool(server.id, tool.name, toolClass as 'read' | 'write' | 'unknown')
    await loadTools(server.id)
  })
}

function togglePinned(server: McpServerConfigWire, tool: McpToolInfoWire): void {
  void run(server.id, async () => {
    await window.bond.mcpPromoteTool(server.id, tool.name, !tool.promoted)
    await loadTools(server.id)
  })
}

function toggleAlwaysAsk(server: McpServerConfigWire, tool: McpToolInfoWire): void {
  void run(server.id, async () => {
    await window.bond.mcpSetAlwaysAsk(server.id, tool.name, !tool.alwaysAsk)
    await loadTools(server.id)
  })
}

function openTokenForm(server: McpServerConfigWire): void {
  tokenDraftId.value = tokenDraftId.value === server.id ? '' : server.id
  tokenDraft.value = ''
}

/**
 * Stores the token in the Keychain and points the Authorization header at it.
 * The config only ever holds the reference.
 */
function saveToken(server: McpServerConfigWire): void {
  const value = tokenDraft.value.trim()
  if (!value) return
  const ref = `${server.id}-token`
  void run(server.id, async () => {
    await window.bond.mcpSetSecret(ref, value)
    await window.bond.mcpUpdate(server.id, {
      headers: { ...(server.headers ?? {}), Authorization: `Bearer keychain:${ref}` },
    })
    tokenDraft.value = ''
    tokenDraftId.value = ''
  })
}

function clearToken(server: McpServerConfigWire, ref: string): void {
  void run(server.id, async () => {
    const headers = Object.fromEntries(
      Object.entries(server.headers ?? {}).filter(([, value]) => !value.includes(`keychain:${ref}`)),
    )
    await window.bond.mcpUpdate(server.id, { headers })
    await window.bond.mcpDeleteSecret(ref)
  })
}

function addPreset(preset: McpServerPresetWire): void {
  void run(preset.id, () => window.bond.mcpAddPreset(preset.id))
}

async function addFromJson(): Promise<void> {
  const text = jsonDraft.value.trim()
  if (!text) return
  error.value = ''
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    error.value = `That isn't valid JSON: ${message(err)}`
    return
  }
  await run('json', async () => {
    await window.bond.mcpAdd(parsed as Partial<McpServerConfigWire>)
    jsonDraft.value = ''
    showJsonForm.value = false
  })
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  void load()
  unsubscribe = window.bond.onMcpChanged(() => { void load() })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <h2 class="text-sm font-semibold text-text-primary">MCP connections</h2>
      <p class="text-xs text-muted mt-1">
        Model Context Protocol servers give Bond extra tools. Servers connect on first use, and every
        call asks you first until you say otherwise.
      </p>
    </div>

    <div v-if="servers.length" class="server-list">
      <div v-for="server in servers" :key="server.id" class="server-entry">
        <div class="server-row">
          <button type="button" class="disclosure" :aria-expanded="expandedId === server.id" @click="toggleExpanded(server)">
            <PhCaretRight :size="12" :class="['caret', { open: expandedId === server.id }]" />
          </button>

          <div class="server-main">
            <div class="flex items-center gap-2 min-w-0">
              <span class="state-dot" :class="stateOf(server)" />
              <BondText size="sm" weight="medium" truncate>{{ server.name }}</BondText>
              <BondText size="xs" color="muted">{{ STATE_LABELS[stateOf(server)] }}</BondText>
              <BondText v-if="statusFor(server.id)?.toolCount" size="xs" color="muted">
                · {{ statusFor(server.id)?.toolCount }} tools
              </BondText>
              <span v-if="statusFor(server.id)?.secretRefs?.length" class="key-badge" v-tooltip="'Token stored in your Keychain'">
                <PhKey :size="11" weight="fill" />
              </span>
            </div>
            <code class="server-command">{{ endpointOf(server) }}</code>
            <BondText v-if="statusFor(server.id)?.error" size="xs" color="err">
              {{ statusFor(server.id)?.error }}
            </BondText>
          </div>

          <div class="server-actions">
            <button
              type="button"
              :class="['toggle-switch', { on: server.enabled }]"
              :disabled="busyId === server.id"
              v-tooltip="server.enabled ? 'Disable' : 'Enable'"
              :aria-label="server.enabled ? `Disable ${server.name}` : `Enable ${server.name}`"
              @click="toggle(server)"
            >
              <span class="toggle-knob" />
            </button>
            <button
              type="button"
              class="icon-btn"
              :disabled="busyId === server.id"
              v-tooltip="'Reconnect'"
              :aria-label="`Reconnect ${server.name}`"
              @click="reconnect(server)"
            >
              <PhArrowClockwise :size="14" />
            </button>
            <button
              type="button"
              class="icon-btn danger"
              :disabled="busyId === server.id"
              v-tooltip="confirmRemoveId === server.id ? 'Click again to remove' : 'Remove'"
              :aria-label="`Remove ${server.name}`"
              @click="remove(server)"
            >
              <PhTrash :size="14" />
            </button>
          </div>
        </div>

        <div v-if="expandedId === server.id" class="server-detail">
          <div class="detail-row">
            <div class="flex flex-col gap-0.5 min-w-0">
              <BondText size="xs" weight="medium">Trust</BondText>
              <BondText size="xs" color="muted">{{ trustHint(server.policy) }}</BondText>
            </div>
            <BondSelect
              size="sm"
              :modelValue="server.policy.trust"
              :options="TRUST_OPTIONS"
              @update:modelValue="value => setTrust(server, value)"
            />
          </div>

          <div v-if="server.transport === 'http'" class="detail-row">
            <div class="flex flex-col gap-0.5 min-w-0">
              <BondText size="xs" weight="medium">Token</BondText>
              <BondText size="xs" color="muted">
                {{ statusFor(server.id)?.secretRefs?.length
                  ? `Stored in your Keychain as ${statusFor(server.id)?.secretRefs?.join(', ')}.`
                  : 'Stored in your macOS Keychain — never in Bond\'s settings.' }}
              </BondText>
            </div>
            <div class="flex items-center gap-2">
              <BondButton
                v-for="ref in statusFor(server.id)?.secretRefs ?? []"
                :key="ref"
                variant="ghost"
                size="sm"
                :disabled="busyId === server.id"
                @click="clearToken(server, ref)"
              >
                Clear
              </BondButton>
              <BondButton variant="secondary" size="sm" @click="openTokenForm(server)">
                {{ tokenDraftId === server.id ? 'Cancel' : 'Set token' }}
              </BondButton>
            </div>
          </div>

          <div v-if="tokenDraftId === server.id" class="token-form">
            <BondInput v-model="tokenDraft" type="password" placeholder="Paste the token — it goes straight to the Keychain" />
            <BondButton variant="primary" size="sm" :disabled="!tokenDraft.trim() || busyId === server.id" @click="saveToken(server)">
              Save
            </BondButton>
          </div>

          <div class="tool-header">
            <BondText size="xs" weight="medium">Tools</BondText>
            <BondText size="xs" color="muted">
              Read runs without asking on a trusted server. Write always asks — an MCP write lands in someone else's system.
            </BondText>
          </div>

          <!--
            Read/Write below do nothing while trust is "Ask every time" — the
            server-level setting overrides them. Saying so (and offering the
            one click that fixes it) beats letting someone set a control that
            silently has no effect.
          -->
          <div v-if="server.policy.trust === 'ask' && hasClassifiedTools(server)" class="pending-note">
            <BondText size="xs" color="muted">
              These settings take effect once this server is trusted — right now every call still asks.
            </BondText>
            <BondButton variant="secondary" size="sm" :disabled="busyId === server.id" @click="setTrust(server, 'trusted')">
              Trust this server
            </BondButton>
          </div>

          <BondText v-if="loadingToolsId === server.id" size="xs" color="muted">Connecting…</BondText>
          <BondText v-else-if="toolErrors[server.id]" size="xs" color="err">{{ toolErrors[server.id] }}</BondText>
          <BondText v-else-if="!toolsByServer[server.id]?.length" size="xs" color="muted">
            This server reported no tools.
          </BondText>

          <div v-else class="tool-list">
            <div v-for="tool in toolsByServer[server.id]" :key="tool.name" class="tool-row">
              <div class="tool-head">
                <div class="tool-identity">
                  <BondText size="sm" weight="medium" mono truncate>{{ tool.name }}</BondText>
                  <span v-if="tool.promoted" class="chip accent">pinned</span>
                  <!--
                    "Always ask" isn't redundant with the Ask state: a tool can
                    be classified read (so a readonly session may use it at all)
                    and still demand confirmation. It's set from the CLI, so the
                    UI's job is to make it visible and one click to clear.
                  -->
                  <button
                    v-if="tool.alwaysAsk"
                    type="button"
                    class="chip chip-button"
                    v-tooltip="'Always asks before running. Click to stop.'"
                    :aria-label="`Stop always asking before ${tool.name}`"
                    @click="toggleAlwaysAsk(server, tool)"
                  >always asks</button>
                </div>
                <div class="tool-actions">
                  <BondTab
                    size="sm"
                    :tabs="PERMISSION_TABS"
                    :modelValue="tool.toolClass"
                    @update:modelValue="value => classify(server, tool, value)"
                  />
                  <button
                    type="button"
                    :class="['icon-btn', { active: tool.promoted }]"
                    v-tooltip="tool.promoted ? 'Unpin from Bond\'s tool list' : 'Pin as a first-class Bond tool'"
                    :aria-label="`Pin ${tool.name}`"
                    @click="togglePinned(server, tool)"
                  >
                    <PhPushPin :size="14" :weight="tool.promoted ? 'fill' : 'regular'" />
                  </button>
                </div>
              </div>

              <p v-if="catalogOf(tool).summary" class="tool-summary">{{ catalogOf(tool).summary }}</p>

              <!--
                A proxy tool's real surface lives in its description as a
                bulleted catalog. Showing those entries as chips is the whole
                point: "reaches 10 providers" is the fact you need to decide
                whether this may run unattended.
              -->
              <div v-if="reachOf(tool).length" class="reach">
                <BondText size="xs" color="muted">
                  Reaches {{ reachOf(tool).length }} {{ routeNoun(tool) }} — set any one separately
                </BondText>
                <div class="reach-chips">
                  <button
                    v-for="name in reachOf(tool)"
                    :key="name"
                    type="button"
                    :class="['reach-chip', routeClassOf(tool, name), { open: openEntryKey === `${tool.name}:${name}` }]"
                    :aria-expanded="openEntryKey === `${tool.name}:${name}`"
                    @click="toggleEntry(tool, name)"
                  >{{ name }}</button>
                </div>

                <div v-if="openRoute(tool)" class="route-detail">
                  <div class="route-detail-head">
                    <BondText size="xs" weight="medium" mono>{{ tool.name }}: {{ openRoute(tool) }}</BondText>
                    <BondTab
                      size="sm"
                      :tabs="PERMISSION_TABS"
                      :modelValue="routeClassOf(tool, openRoute(tool)!)"
                      @update:modelValue="value => classifyRoute(server, tool, openRoute(tool)!, value)"
                    />
                  </div>
                  <p v-if="entryText(tool, openRoute(tool)!)" class="reach-detail">{{ entryText(tool, openRoute(tool)!) }}</p>
                </div>
              </div>

              <BondText v-if="tool.toolClass === 'unknown' && tool.suggestedClass !== 'unknown'" size="xs" color="muted">
                The server says this is {{ tool.suggestedClass === 'read' ? 'read-only' : 'a write' }} — confirm it yourself.
              </BondText>
            </div>
          </div>
        </div>
      </div>
    </div>
    <BondText v-else size="xs" color="muted">No MCP servers connected yet.</BondText>

    <BondText v-if="error" size="xs" color="err">{{ error }}</BondText>

    <div v-if="unusedPresets.length" class="preset-list">
      <div v-for="preset in unusedPresets" :key="preset.id" class="preset-row">
        <div class="flex flex-col gap-0.5 min-w-0">
          <BondText size="sm" weight="medium">{{ preset.name }}</BondText>
          <BondText size="xs" color="muted">{{ preset.description }}</BondText>
        </div>
        <BondButton variant="secondary" size="sm" :disabled="busyId === preset.id" @click="addPreset(preset)">
          Connect
        </BondButton>
      </div>
    </div>

    <div class="json-add">
      <BondButton variant="ghost" size="sm" @click="showJsonForm = !showJsonForm">
        {{ showJsonForm ? 'Cancel' : 'Add from JSON' }}
      </BondButton>
      <template v-if="showJsonForm">
        <BondTextarea
          v-model="jsonDraft"
          :rows="5"
          placeholder='{ "id": "my-server", "command": "npx", "args": ["-y", "some-mcp-server"] }
or { "id": "remote", "url": "https://example.com/mcp" }'
        />
        <div class="flex justify-end">
          <BondButton variant="primary" size="sm" :disabled="!jsonDraft.trim() || busyId === 'json'" @click="addFromJson">
            Add server
          </BondButton>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-header {
  display: flex;
  flex-direction: column;
}

.server-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.server-entry + .server-entry {
  border-top: 1px solid var(--color-border);
}

.server-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
}

.disclosure {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--color-muted);
}
.caret {
  transition: transform var(--transition-fast);
}
.caret.open {
  transform: rotate(90deg);
}

.server-main {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  flex: 1;
}

.server-command {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-muted);
  word-break: break-all;
}

.server-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
}

.server-detail {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 0.75rem 0.875rem 2rem;
  border-top: 1px dashed var(--color-border);
  background: var(--color-tint);
}

.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.token-form {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.token-form > :first-child {
  flex: 1;
}

.tool-header {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  margin-top: 0.25rem;
}

.tool-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}

.tool-row {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.625rem 0.75rem;
}
.tool-row + .tool-row {
  border-top: 1px solid var(--color-border);
}

.tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.tool-identity {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}

.tool-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
}

/* A readable measure, and the source's own line breaks preserved — the
   newlines were always in the description; HTML was collapsing them. */
.tool-summary {
  margin: 0;
  max-width: 62ch;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-muted);
  white-space: pre-line;
  text-wrap: pretty;
}

.reach {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.reach-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.reach-chip {
  all: unset;
  cursor: pointer;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-muted);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.reach-chip:hover {
  color: var(--color-text-primary);
  border-color: var(--color-muted);
}
.reach-chip.open {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
}
.reach-chip:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

.route-detail {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.route-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.pending-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}

/* A glance should show which providers already have a rule. */
.reach-chip.read {
  color: var(--color-ok);
  border-color: color-mix(in srgb, var(--color-ok) 45%, transparent);
}
.reach-chip.write {
  color: var(--color-err);
  border-color: color-mix(in srgb, var(--color-err) 45%, transparent);
}

.reach-detail {
  margin: 0;
  max-width: 62ch;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--color-muted);
  text-wrap: pretty;
}

.chip {
  font-size: 0.65rem;
  padding: 0.05rem 0.35rem;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  color: var(--color-muted);
  white-space: nowrap;
}
.chip.accent {
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  color: var(--color-accent);
}

.chip-button {
  all: unset;
  cursor: pointer;
  font-size: 0.65rem;
  padding: 0.05rem 0.35rem;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  color: var(--color-muted);
  white-space: nowrap;
}
.chip-button:hover {
  color: var(--color-text-primary);
}
.chip-button:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

.key-badge {
  display: flex;
  align-items: center;
  color: var(--color-muted);
  flex-shrink: 0;
}

.state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-muted);
}
.state-dot.connected { background: var(--color-ok); }
.state-dot.connecting { background: var(--color-accent); }
.state-dot.error { background: var(--color-err); }
.state-dot.disabled { background: var(--color-border); }

.icon-btn {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-md);
  color: var(--color-muted);
  font-size: 0.75rem;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.icon-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-tint);
}
.icon-btn.active {
  color: var(--color-accent);
}
.icon-btn.danger:hover {
  color: var(--color-err);
}
.icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

/* Matches the Sense toggle so both settings read as the same control. */
.toggle-switch {
  all: unset;
  cursor: pointer;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--color-border);
  position: relative;
  transition: background var(--transition-base);
  flex-shrink: 0;
}
.toggle-switch.on {
  background: var(--color-accent);
}
.toggle-switch:disabled {
  cursor: default;
  opacity: 0.6;
}
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  box-shadow: var(--shadow-sm);
  transition: transform var(--transition-base);
}
.toggle-switch.on .toggle-knob {
  transform: translateX(16px);
}

.preset-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 0.75rem;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
}

.json-add {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
}
.json-add > :not(:first-child) {
  width: 100%;
}
</style>
