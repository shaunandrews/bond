<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { PhWarning, PhTerminal } from '@phosphor-icons/vue'
import BondSelect from './BondSelect.vue'
import BondButton from './BondButton.vue'
import BondText from './BondText.vue'
import {
  AGENT_LEASH_MAX_SECONDS,
  AGENT_LEASH_MIN_SECONDS,
  GRANTABLE_AGENT_TOOLS,
  type AgentProblem,
  type AgentSettings,
  type AgentSummary,
} from '../../shared/agents'

const agents = ref<AgentSummary[]>([])
const problems = ref<AgentProblem[]>([])
const loading = ref(true)
const instructionDrafts = ref<Record<string, string>>({})

const modelOptions = [
  { value: 'inherit', label: 'Inherit from chat' },
  { value: 'high', label: 'High capability' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'fast', label: 'Fast' },
]

const thinkingOptions = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

const reportOptions = [
  { value: 'full', label: 'Full report' },
  { value: 'quick', label: 'Quick take' },
]

const policyOptions = [
  { value: 'on-demand', label: 'Only when asked' },
  { value: 'suggest', label: 'Offer to consult' },
  { value: 'auto', label: 'Consult proactively' },
]

const toolLabels: Record<string, string> = {
  web_search: 'Web search',
  fetch_content: 'Fetch pages',
}

async function load() {
  try {
    const roster = await window.bond.listAgents()
    agents.value = roster.agents
    problems.value = roster.problems
    instructionDrafts.value = Object.fromEntries(roster.agents.map(agent => [agent.name, agent.settings.instructions]))
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function update(agent: AgentSummary, settings: Partial<AgentSettings>) {
  const updated = await window.bond.updateAgentSettings(agent.name, settings)
  agents.value = agents.value.map(entry => (entry.name === updated.name ? updated : entry))
}

function draftDirty(agent: AgentSummary): boolean {
  return (instructionDrafts.value[agent.name] ?? '') !== agent.settings.instructions
}

async function saveInstructions(agent: AgentSummary) {
  await update(agent, { instructions: instructionDrafts.value[agent.name] ?? '' })
}

function discardInstructions(agent: AgentSummary) {
  instructionDrafts.value[agent.name] = agent.settings.instructions
}

function toggleTool(agent: AgentSummary, tool: string) {
  const tools = agent.settings.tools.includes(tool)
    ? agent.settings.tools.filter(entry => entry !== tool)
    : [...agent.settings.tools, tool]
  return update(agent, { tools })
}

function handleLeash(agent: AgentSummary, event: Event) {
  const value = parseInt((event.target as HTMLInputElement).value, 10)
  return update(agent, { leash: value })
}

async function revokeRunner(command: string) {
  const roster = await window.bond.revokeAgentRunner(command)
  agents.value = roster.agents
  problems.value = roster.problems
}
</script>

<template>
  <main class="agents-content px-6 pb-8">
    <section>
      <p class="section-intro">
        Agents are specialists Bond consults for focused work. Each runs in its own isolated session,
        reads what it needs, and hands Bond a result — you keep one conversation. Felix and Q remain
        read-only; Mathis can write only inside a retained per-run git worktree after brief confirmation.
      </p>
      <p class="section-intro mt-2">
        Add your own at <code>~/.bond/agents/&lt;name&gt;/AGENT.md</code>.
      </p>
    </section>

    <p v-if="loading" class="section-intro">Loading roster…</p>

    <section v-if="problems.length" class="problem-list">
      <div v-for="problem in problems" :key="problem.source" class="problem-row">
        <PhWarning :size="14" weight="fill" />
        <div class="min-w-0">
          <BondText size="xs" weight="medium">{{ problem.source }}</BondText>
          <BondText size="xs" color="muted" as="p">{{ problem.reason }}</BondText>
        </div>
      </div>
    </section>

    <section v-for="agent in agents" :key="agent.name" class="agent-card">
      <div class="agent-header">
        <div class="agent-mark">{{ agent.mark }}</div>
        <div class="agent-title">
          <span class="agent-name">{{ agent.label }}</span>
          <span class="agent-role">{{ agent.role }}</span>
        </div>
        <span class="agent-source">{{ agent.source === 'builtin' ? 'built-in' : 'custom' }}</span>
      </div>

      <p v-if="agent.bio" class="agent-bio">{{ agent.bio }}</p>

      <h3 class="agent-subtitle">Verbs</h3>
      <div class="verb-grid">
        <div v-for="verb in agent.verbs" :key="verb.name" class="verb-card">
          <span class="verb-name">{{ verb.name }}</span>
          <span class="verb-desc">{{ verb.description || 'No description in the definition.' }}</span>
        </div>
      </div>

      <h3 class="agent-subtitle">Settings</h3>
      <div class="setting-grid">
        <label class="setting-row">
          <span class="setting-label">Model</span>
          <BondSelect
            :modelValue="agent.settings.model"
            :options="modelOptions"
            size="sm"
            @update:modelValue="value => update(agent, { model: value as AgentSettings['model'] })"
          />
        </label>
        <label class="setting-row">
          <span class="setting-label">Thinking</span>
          <BondSelect
            :modelValue="agent.settings.thinking"
            :options="thinkingOptions"
            size="sm"
            @update:modelValue="value => update(agent, { thinking: value as AgentSettings['thinking'] })"
          />
        </label>
        <label class="setting-row">
          <span class="setting-label">Report</span>
          <BondSelect
            :modelValue="agent.settings.report"
            :options="reportOptions"
            size="sm"
            @update:modelValue="value => update(agent, { report: value as AgentSettings['report'] })"
          />
        </label>
        <label class="setting-row">
          <span class="setting-label">Consult</span>
          <BondSelect
            :modelValue="agent.settings.policy"
            :options="policyOptions"
            size="sm"
            @update:modelValue="value => update(agent, { policy: value as AgentSettings['policy'] })"
          />
        </label>
      </div>

      <div class="leash-row">
        <span class="setting-label">Time limit</span>
        <input
          type="range"
          class="leash-slider"
          :min="AGENT_LEASH_MIN_SECONDS"
          :max="AGENT_LEASH_MAX_SECONDS"
          step="30"
          :value="agent.settings.leash"
          @change="event => handleLeash(agent, event)"
        />
        <BondText size="xs" color="muted" mono>{{ Math.round(agent.settings.leash / 60) }}m</BondText>
      </div>

      <div class="tool-row">
        <span class="setting-label">Extra tools</span>
        <div class="tool-chips">
          <button
            v-for="tool in GRANTABLE_AGENT_TOOLS"
            :key="tool"
            type="button"
            :class="['tool-chip', { on: agent.settings.tools.includes(tool) }]"
            @click="toggleTool(agent, tool)"
          >
            {{ toolLabels[tool] ?? tool }}
          </button>
        </div>
      </div>

      <h3 class="agent-subtitle">Instructions</h3>
      <p class="agent-hint">Standing context for {{ agent.label }} — added to every consult.</p>
      <textarea
        v-model="instructionDrafts[agent.name]"
        class="instructions-editor"
        :placeholder="`e.g. We're a WordPress shop. Tokens live in theme.json — never suggest Tailwind.`"
        spellcheck="false"
      />
      <div v-if="draftDirty(agent)" class="instruction-actions">
        <BondButton variant="ghost" size="sm" @click="discardInstructions(agent)">Discard</BondButton>
        <BondButton variant="primary" size="sm" @click="saveInstructions(agent)">Save</BondButton>
      </div>

      <template v-if="agent.evidence.length">
        <h3 class="agent-subtitle">Checks</h3>
        <p class="agent-hint">
          Deterministic checks Bond runs before the consult. Commands need your approval the first time they run.
        </p>
        <div class="evidence-list">
          <div v-for="runner in agent.evidence" :key="runner.name" class="evidence-row">
            <PhTerminal :size="13" weight="regular" class="evidence-icon" />
            <div class="min-w-0 flex-1">
              <BondText size="xs" weight="medium">{{ runner.name }}</BondText>
              <code class="evidence-command">{{ runner.command }}</code>
            </div>
            <span v-if="runner.kind === 'native'" class="evidence-badge">built-in</span>
            <span v-else-if="runner.approved" class="evidence-badge approved">approved</span>
            <span v-else class="evidence-badge">needs approval</span>
            <button
              v-if="runner.kind === 'shell' && runner.approved"
              type="button"
              class="revoke-btn"
              @click="revokeRunner(runner.command)"
            >
              Revoke
            </button>
          </div>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.agents-content {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.section-intro {
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--color-muted);
}

.agent-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}

.agent-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.agent-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent);
  font-size: 1.25rem;
  font-weight: 700;
}

.agent-title {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.agent-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.agent-role {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.agent-source {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  color: var(--color-muted);
}

.agent-bio {
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--color-text-primary);
}

.agent-subtitle {
  margin-top: 0.5rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-muted);
}

.agent-hint {
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-muted);
}

.verb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.5rem;
}

.verb-card {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.verb-name {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-accent);
}

.verb-desc {
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-muted);
}

.setting-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.5rem 1rem;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.setting-label {
  font-size: 0.8rem;
  color: var(--color-text-primary);
  flex-shrink: 0;
}

.leash-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.leash-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: var(--color-border);
  outline: none;
  cursor: pointer;
}
.leash-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-accent);
  border: 2px solid var(--color-surface);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.tool-chip {
  all: unset;
  cursor: pointer;
  font-size: 0.72rem;
  padding: 0.2rem 0.55rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  color: var(--color-muted);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.tool-chip:hover {
  color: var(--color-text-primary);
}
.tool-chip.on {
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  color: var(--color-accent);
}

.instructions-editor {
  width: 100%;
  min-height: 88px;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.6;
  resize: vertical;
  box-sizing: border-box;
  outline: none;
  transition: border-color var(--transition-base);
}
.instructions-editor::placeholder {
  color: var(--color-muted);
  opacity: 0.6;
}
.instructions-editor:focus {
  border-color: var(--color-accent);
}

.instruction-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.evidence-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.evidence-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
}
.evidence-row + .evidence-row {
  border-top: 1px solid var(--color-border);
}

.evidence-icon {
  color: var(--color-muted);
  flex-shrink: 0;
}

.evidence-command {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-muted);
  word-break: break-all;
}

.evidence-badge {
  flex-shrink: 0;
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.12rem 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--color-tint);
  color: var(--color-muted);
}
.evidence-badge.approved {
  background: color-mix(in srgb, var(--color-ok) 15%, transparent);
  color: var(--color-ok);
}

.revoke-btn {
  all: unset;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--color-muted);
  transition: color var(--transition-fast);
}
.revoke-btn:hover {
  color: var(--color-err);
}

.problem-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--color-err) 35%, var(--color-border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-err) 6%, transparent);
}

.problem-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  color: var(--color-err);
}
</style>
