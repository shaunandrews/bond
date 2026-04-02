<script setup lang="ts">
const version = '0.1.0'

const layers = [
  {
    name: 'Renderer',
    tech: 'Vue 3 + Tailwind CSS v4',
    description: 'Chat UI, session management, settings, and design system browser. Composition API throughout.',
    files: 'src/renderer/',
  },
  {
    name: 'Main Process',
    tech: 'Electron',
    description: 'Window management, daemon lifecycle, and IPC proxy. Spawns the daemon on launch and bridges renderer calls to it.',
    files: 'src/main/',
  },
  {
    name: 'Daemon',
    tech: 'Node.js + WebSocket + SQLite',
    description: 'Standalone process on a Unix socket. Runs agent queries via the Claude Agent SDK, streams responses, and persists sessions to a local database.',
    files: 'src/daemon/',
  },
  {
    name: 'Claude API',
    tech: 'Claude Agent SDK',
    description: 'Queries are dispatched through @anthropic-ai/claude-agent-sdk. Authenticates via your existing Claude Code CLI session.',
    files: 'src/daemon/agent.ts',
  },
]

const tools = [
  { name: 'Read', description: 'Read file contents' },
  { name: 'Glob', description: 'Find files by pattern' },
  { name: 'Grep', description: 'Search file contents' },
  { name: 'Edit', description: 'Modify existing files' },
  { name: 'Write', description: 'Create new files' },
  { name: 'Bash', description: 'Run shell commands' },
  { name: 'WebSearch', description: 'Search the web' },
  { name: 'WebFetch', description: 'Fetch a URL' },
]

const editModes = [
  { name: 'Full', description: 'All tools available — read, write, edit, and execute.' },
  { name: 'Readonly', description: 'Read, Glob, and Grep only. No modifications.' },
  { name: 'Scoped', description: 'Read and write restricted to specific paths you choose.' },
]

const dataPaths = [
  { path: '~/.bond/bond.sock', purpose: 'Unix domain socket for daemon communication' },
  { path: '~/.bond/daemon.pid', purpose: 'Process ID of the running daemon' },
  { path: '~/.bond/daemon.log', purpose: 'Daemon output log' },
  { path: '~/Library/Application Support/bond/bond.db', purpose: 'SQLite database (sessions, messages, settings)' },
]
</script>

<template>
  <main class="about-content px-6 pb-8">
    <!-- Hero -->
    <section class="about-hero">
      <div class="hero-mark">B</div>
      <p class="hero-tagline">A macOS assistant powered by Claude.</p>
      <p class="hero-version">Version {{ version }}</p>
    </section>

    <!-- Architecture -->
    <section class="about-section">
      <h2 class="section-title">Architecture</h2>
      <p class="section-intro">
        Bond separates concerns across four layers. The renderer never touches the Agent SDK directly — all queries flow through a standalone daemon over a Unix socket.
      </p>

      <div class="arch-stack">
        <div v-for="(layer, i) in layers" :key="layer.name" class="arch-layer">
          <div class="layer-header">
            <span class="layer-name">{{ layer.name }}</span>
            <span class="layer-tech">{{ layer.tech }}</span>
          </div>
          <p class="layer-desc">{{ layer.description }}</p>
          <code class="layer-path">{{ layer.files }}</code>
          <div v-if="i < layers.length - 1" class="arch-connector">
            <svg width="2" height="20" viewBox="0 0 2 20">
              <line x1="1" y1="0" x2="1" y2="20" stroke="var(--color-border)" stroke-width="2" stroke-dasharray="3,3" />
            </svg>
          </div>
        </div>
      </div>
    </section>

    <!-- Agent Tools -->
    <section class="about-section">
      <h2 class="section-title">Agent Tools</h2>
      <p class="section-intro">
        The tools available to Bond depend on the edit mode selected for each session.
      </p>

      <div class="tool-grid">
        <div v-for="tool in tools" :key="tool.name" class="tool-card">
          <span class="tool-name">{{ tool.name }}</span>
          <span class="tool-desc">{{ tool.description }}</span>
        </div>
      </div>
    </section>

    <!-- Edit Modes -->
    <section class="about-section">
      <h2 class="section-title">Edit Modes</h2>
      <div class="mode-list">
        <div v-for="mode in editModes" :key="mode.name" class="mode-item">
          <span class="mode-name">{{ mode.name }}</span>
          <span class="mode-desc">{{ mode.description }}</span>
        </div>
      </div>
    </section>

    <!-- Data & Storage -->
    <section class="about-section">
      <h2 class="section-title">Data &amp; Storage</h2>
      <p class="section-intro">
        All data stays on your machine. Sessions and settings are stored in a local SQLite database. The daemon communicates over a Unix domain socket — nothing leaves your network except API calls to Claude.
      </p>
      <div class="data-table">
        <div v-for="item in dataPaths" :key="item.path" class="data-row">
          <code class="data-path">{{ item.path }}</code>
          <span class="data-purpose">{{ item.purpose }}</span>
        </div>
      </div>
    </section>

    <!-- CLI -->
    <section class="about-section">
      <h2 class="section-title">CLI</h2>
      <p class="section-intro">
        The <code class="inline-code">bond</code> command manages the daemon and dev workflow from your terminal.
      </p>
      <div class="cli-commands">
        <div class="cli-row"><code>bond status</code><span>Check if daemon is running</span></div>
        <div class="cli-row"><code>bond start</code><span>Start the daemon</span></div>
        <div class="cli-row"><code>bond stop</code><span>Stop the daemon</span></div>
        <div class="cli-row"><code>bond dev</code><span>Full dev server with hot reload</span></div>
        <div class="cli-row"><code>bond log</code><span>Tail the daemon log</span></div>
        <div class="cli-row"><code>bond build</code><span>Production build</span></div>
        <div class="cli-row"><code>bond todo</code><span>Manage todos (list, add, done, undo, rm)</span></div>
        <div class="cli-row"><code>bond project</code><span>Manage projects (list, add, show, edit, archive, rm)</span></div>
        <div class="cli-row"><code>bond media</code><span>Manage media (list, info, open, rm, purge)</span></div>
      </div>
    </section>

  </main>
</template>

<style scoped>
.about-content {
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
}

/* Hero */
.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 1rem 0 0;
}

.hero-mark {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-xl);
  background: var(--color-accent);
  color: #fff;
  font-size: 1.5rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.75rem;
}

.hero-tagline {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--color-text-primary);
  margin: 0;
}

.hero-version {
  font-size: 0.8125rem;
  color: var(--color-muted);
  margin: 0.25rem 0 0;
  font-variant-numeric: tabular-nums;
}

/* Sections */
.about-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text-primary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0;
}

.section-intro {
  font-size: 0.875rem;
  line-height: 1.55;
  color: var(--color-muted);
  margin: 0;
}

/* Architecture stack */
.arch-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.arch-layer {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}

.arch-connector {
  display: flex;
  justify-content: center;
  padding: 0.125rem 0;
  flex-shrink: 0;
}

.layer-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.layer-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.layer-tech {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.layer-desc {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-muted);
  margin: 0;
}

.layer-path {
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--color-accent);
}

/* Tool grid */
.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
}

.tool-card {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.tool-name {
  font-size: 0.8125rem;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--color-text-primary);
}

.tool-desc {
  font-size: 0.75rem;
  color: var(--color-muted);
}

/* Edit modes */
.mode-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.mode-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.mode-name {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.mode-desc {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-muted);
}

/* Data table */
.data-table {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.data-row {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.data-path {
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--color-accent);
}

.data-purpose {
  font-size: 0.8125rem;
  color: var(--color-muted);
}

/* CLI commands */
.cli-commands {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.cli-row {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.cli-row code {
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  min-width: 7rem;
}

.cli-row span {
  font-size: 0.8125rem;
  color: var(--color-muted);
}

.inline-code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
}

</style>
