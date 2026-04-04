# Project Context in Chat

When a project is selected in the sidebar or linked to a session, its details should be injected into the AI's context — and the user should see what context is active.

---

## Why

Right now the system prompt describes how to behave when a chat is linked to a project, but the actual project data (name, goal, deadline, resources) never makes it into the prompt. The `session.projectId` is stored in the DB but ignored at query time. Similarly, browsing a project in the sidebar panel has zero effect on the chat — it's purely visual.

This means:
- Starting a chat from a project only works because `handleProjectStartChat` manually submits a message with the project name/goal baked in
- Selecting a project in the sidebar while chatting does nothing
- There's no visual indicator in the chat UI showing what project context is active

---

## Two Sources of Context

### 1. Session-linked project (`session.projectId`)
Set when a chat is created from a project (via "Start chat" button). Persisted in DB. This is the strong link — the session belongs to this project.

### 2. Sidebar-selected project (`activeProjectId`)
Ephemeral UI state stored in localStorage. Changes as the user browses projects in the panel. This is a softer signal — "I'm looking at this project right now."

### Resolution
- If the session has a `projectId`, that's the context. The sidebar selection is irrelevant.
- If the session has no `projectId` but a project is selected in the sidebar, offer to use it as context (or auto-include it — TBD, might feel too magic).
- The user should be able to attach/detach a project from the current session at any time.

---

## Daemon: Inject Project into System Prompt

### Changes to `server.ts`

In the `chat.send` handler (~line 266), before calling `runBondQuery`:

```ts
// Look up project context if session is linked
let projectContext: Project | null = null
if (session.projectId) {
  projectContext = getProject(session.projectId) ?? null
}
```

Pass `projectContext` into `runBondQuery` options.

### Changes to `agent.ts`

Add a `project` option to `runBondQuery`. If present, append a context block to the system prompt:

```ts
if (options.project) {
  const p = options.project
  const lines = [
    `\nThis chat is linked to the project "${p.name}".`,
    p.goal ? `Goal: ${p.goal}` : null,
    p.type !== 'generic' ? `Type: ${p.type}` : null,
    p.deadline ? `Deadline: ${p.deadline}` : null,
  ].filter(Boolean)

  if (p.resources.length) {
    lines.push('Resources:')
    for (const r of p.resources) {
      const label = r.label ? `${r.label} — ` : ''
      lines.push(`  - [${r.kind}] ${label}${r.value}`)
    }
  }

  systemPrompt += '\n' + lines.join('\n')
}
```

This gives the AI everything it needs to stay focused on the project — read resource files, respect deadlines, associate new todos, etc.

---

## Renderer: Context Indicator in Chat UI

### Location
Below the chat header / above the message list — a slim, dismissible bar. Or: integrated into the `ChatInput` area as a context pill.

Leaning toward a pill above the input — similar to how attachment previews sit above the composer in messaging apps. Unobtrusive, always visible when active, easy to dismiss.

### Design

```
┌──────────────────────────────────────────┐
│  [messages...]                           │
│                                          │
│  ┌────────────────────────────┐          │
│  │ 🔗 WP Connectors       ✕  │          │
│  └────────────────────────────┘          │
│  ┌────────────────────────────────────┐  │
│  │ Message input...                   │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

- Shows project name with a link icon
- Click the pill to expand/view project details (or navigate to project panel)
- `✕` detaches the project from the session
- If no project is linked, the pill doesn't render

### Attaching a project
- Drag a project from the sidebar panel onto the chat area (stretch goal)
- Or: add a "Link to project" action in the chat header menu / context menu
- Or: when a project is selected in the sidebar and the user starts typing, show a subtle prompt: "Include WP Connectors context?" (might be too noisy)

Simplest v1: a dropdown/picker in the chat header or input area. Select a project, it sets `session.projectId`.

---

## Renderer: Wiring the Sidebar Selection

When a project is selected in the sidebar panel AND the current session has no `projectId`:

Option A — **Auto-attach**: Set `session.projectId` automatically. Too aggressive — user might just be browsing.

Option B — **Suggest**: Show a transient prompt near the input: "Chat about WP Connectors?" with an action to link it. Better, but adds UI noise.

Option C — **Do nothing automatically**: The sidebar is for browsing. Linking is an explicit action (via the pill/picker). The "Start chat" button on the project detail already creates a linked session. This is the simplest and least surprising.

**Going with Option C for v1.** The sidebar selection stays visual-only. Linking is explicit.

---

## Implementation Order

1. **Daemon injection** — Pass project data into system prompt when `session.projectId` exists. This is the functional fix and can ship alone.
2. **Context pill** — Show the linked project in the chat UI. Let users detach it.
3. **Project picker** — Let users attach a project to an existing session from within the chat.
4. **Session sidebar indicator** — Show a small project badge on session items in the session list, so you can see which chats belong to which projects at a glance.

Step 1 is ~30 minutes of work. Steps 2-3 are a small Vue component + a session update call. Step 4 is cosmetic.

---

## Open Questions

- Should the context pill show the project goal as a subtitle, or just the name?
- Should attaching a project retroactively affect the conversation, or only future messages? (Probably just future — the system prompt only applies to new queries.)
- Should we inject todo counts for the project into context? ("This project has 3 pending todos: ...") Could be useful but adds prompt bloat.
