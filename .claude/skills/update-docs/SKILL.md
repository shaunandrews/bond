---
name: update-docs
description: Update Bond's documentation (README, CLAUDE.md, AboutView) to reflect the current codebase. Use after adding components, composables, daemon RPC methods, CLI commands, or changing architecture.
---

# Update Bond Documentation

Keep Bond's three documentation surfaces in sync with the codebase.

## Documentation Surfaces

1. **CLAUDE.md** — Claude Code instructions. Component catalog, composable docs, architecture overview, design tokens, project structure. This is the source of truth for how Claude should work in the codebase.
2. **README.md** — Developer-facing project overview. Architecture diagram, CLI reference, build tooling, data paths, repo layout.
3. **AboutView.vue** (`src/renderer/components/AboutView.vue`) — In-app reference screen. Architecture stack, agent tools, edit modes, data paths, CLI commands.

## What to Update

### When adding or changing a component
- **CLAUDE.md**: Update the Components section — props, events, slots, and a one-line description. Update the Project Structure tree.
- **DevComponents.vue**: Add or update the component's entry in the catalog.
- If it's a new view accessible from the sidebar, update **AboutView.vue** if architecturally relevant.

### When adding or changing a composable
- **CLAUDE.md**: Update the Composables section — state, methods, and a one-line description. Update the Project Structure tree.

### When changing the daemon (new RPC methods, schema changes, agent tools)
- **CLAUDE.md**: Update the Architecture > Daemon section.
- **README.md**: Update the Architecture > Daemon section and any affected RPC method lists.
- **AboutView.vue**: Update the agent tools grid, edit modes, or architecture stack if affected.

### When changing the CLI (`bin/bond`)
- **README.md**: Update the CLI section.
- **AboutView.vue**: Update the CLI commands section.

### When changing design tokens (`app.css` / `App.vue` `<style>`)
- **CLAUDE.md**: Update the Design Tokens section.

### When changing shared types
- **CLAUDE.md**: Update the Message Types, Edit Modes, or Architecture > Shared sections as needed.

## Process

1. **Read the current docs** before editing — don't write from memory, verify what's already there.
2. **Read the source files** that changed to get accurate props, types, method signatures.
3. **Update all three surfaces** that are affected. Don't update docs for things that didn't change.
4. **Keep it terse.** One-line descriptions, prop tables, not paragraphs. Match the existing style in each file.
5. **Run tests** after to make sure nothing broke: `npm run test:run`

## Style Notes

- CLAUDE.md uses markdown with `###` headers per component, bullet-point props/events/slots.
- README.md uses tables for scripts/commands, code fences for the architecture diagram.
- AboutView.vue uses static data arrays in `<script setup>` — update the arrays, not the template.
- Don't add fluff, marketing language, or "built with" credits.
