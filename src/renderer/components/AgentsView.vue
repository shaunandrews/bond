<script setup lang="ts">
const agents = [
  {
    id: 'felix',
    mark: 'F',
    name: 'Felix',
    role: 'Design Consultant',
    bio: 'Bond\'s designer pal. Bond consults him for design judgment — he reads the code, judges it against your design system, and reports back with cited findings. He never edits anything; Bond applies the changes.',
    verbs: [
      { name: 'critique', description: 'Judge a UI surface against its design system and register.' },
      { name: 'define', description: 'Author a DESIGN.md capturing the project\'s visual system.' },
      { name: 'refine', description: 'Grow a system — extraction candidates, spec drift, token lifecycle.' },
      { name: 'migrate', description: 'Map hard-coded values onto tokens as a staged campaign.' },
    ],
    traits: [
      { name: 'Read-only', description: 'Runs in an isolated session with read and search tools only — no writes, no approvals needed, available in every edit mode.' },
      { name: 'Evidence-first', description: 'Every verdict cites file, line, or value. Deterministic design checks (Impeccable\'s detector) run alongside his own judgment.' },
      { name: 'System-first', description: 'Treats your design system as the boundary. Every deviation gets a root cause; proposed additions come back as escalations for your approval.' },
      { name: 'Structured reports', description: 'VERDICT, SCORES, FINDINGS, EXCEPTIONS, ESCALATIONS, and QUESTIONS — Bond relays anything that needs your answer.' },
    ],
    example: 'Have Felix critique the settings screen — register: product.',
  },
]
</script>

<template>
  <main class="agents-content px-6 pb-8">
    <section class="agents-intro-section">
      <p class="section-intro">
        Agents are specialists Bond consults for focused work. They run in their own isolated sessions,
        do their thinking off to the side, and hand Bond a report — you keep one conversation.
      </p>
    </section>

    <section v-for="agent in agents" :key="agent.id" class="agent-card">
      <div class="agent-header">
        <div class="agent-mark">{{ agent.mark }}</div>
        <div class="agent-title">
          <span class="agent-name">{{ agent.name }}</span>
          <span class="agent-role">{{ agent.role }}</span>
        </div>
      </div>

      <p class="agent-bio">{{ agent.bio }}</p>

      <h3 class="agent-subtitle">What he does</h3>
      <div class="verb-grid">
        <div v-for="verb in agent.verbs" :key="verb.name" class="verb-card">
          <span class="verb-name">{{ verb.name }}</span>
          <span class="verb-desc">{{ verb.description }}</span>
        </div>
      </div>

      <h3 class="agent-subtitle">How he works</h3>
      <div class="trait-list">
        <div v-for="trait in agent.traits" :key="trait.name" class="trait-item">
          <span class="trait-name">{{ trait.name }}</span>
          <span class="trait-desc">{{ trait.description }}</span>
        </div>
      </div>

      <h3 class="agent-subtitle">Try it</h3>
      <p class="agent-hint">Ask Bond in chat — he brings Felix in when design judgment is needed:</p>
      <code class="agent-example">{{ agent.example }}</code>
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

.trait-list {
  display: flex;
  flex-direction: column;
}

.trait-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.5rem 0;
  align-items: baseline;
}
.trait-item + .trait-item {
  border-top: 1px solid var(--color-border);
}

.trait-name {
  flex-shrink: 0;
  width: 8.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.trait-desc {
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-muted);
}

.agent-hint {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.agent-example {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-text-primary);
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}
</style>
