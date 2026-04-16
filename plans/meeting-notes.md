# Meeting Notes — Live Capture & Smart Summary Skill

A `/meeting` skill that puts Bond in a quiet capture mode during calls, then synthesizes your typed notes + Sense screen context into a structured summary with project routing and todo extraction.

---

## Why

Every meeting generates knowledge — decisions, action items, context, references — that evaporates within hours if not captured. The tools that exist (Otter, Granola, Fireflies) are cloud-dependent, join your call as a bot, or require audio capture permissions. Bond already has two unique advantages: **Sense** (passive screen awareness) and **the chat input** (always open, always fast). This skill turns those into a meeting companion that captures what you type, enriches it with what you were looking at, and produces structured output routed to the right project.

### Research: What Others Do

**Granola** ($250M valuation, 2025) nailed the core UX insight: during a meeting, you should write *triggers* not *transcripts*. Their notepad lets you jot shorthand while audio transcription runs in the background. Post-meeting, AI combines your notes with the full transcript. Your notes appear in black, AI additions in gray — clear provenance. Every AI bullet links back to the transcript timestamp.

**Meetily** (open source, Rust/Tauri) does local-only transcription via Whisper/Parakeet with Ollama summarization. Full privacy, but requires audio capture setup.

**The pattern across all tools:** capture minimal structured signals during the call, expand with full context after. The user stays present in conversation, not typing furiously.

**Bond's angle:** We don't have audio transcription (and shouldn't — that's a massive scope increase). Instead, Sense already sees what's on screen: Zoom participant names, Figma files, Slack channels, URLs, shared screens. That's context no other note-taking tool has. The user types sparse notes; Sense fills in the environment.

---

## UX Flow

### 1. Start

```
/meeting                              Start with no context
/meeting standup with editor team     Start with a title/context hint
/meeting --project Bond               Start linked to a project
```

Bond responds with a brief confirmation and enters **meeting mode**:

> 📋 Meeting started. Type notes as you go — shorthand is fine. Drop screenshots or links anytime. Say `/meeting end` when you're done.

### 2. During the Call — Quiet Capture

**The critical UX principle:** Bond is *silent* during meeting mode. Every message you send is treated as a note, not a prompt. Bond does not respond, does not process, does not generate — it just accumulates. The chat should feel like a scratchpad, not a conversation.

Why silent? Because you're on a call. You can't read a wall of AI text while someone is talking to you. Granola understood this — their notepad is deliberately dumb during the meeting. Intelligence comes after.

**What you type:**

Freeform text, one message per thought. Fast, messy, abbreviated — Bond will clean it up later.

**Optional shorthand prefixes** (not required, but add structure):

| Prefix | Meaning | Example |
|--------|---------|---------|
| `!` | Action item | `! update the nav prototype by friday` |
| `?` | Open question | `? are we keeping the old sidebar?` |
| `>` | Decision | `> going with option B for the header` |
| `@name` | Attribution | `@matt wants to revisit the color system` |

If you don't use prefixes, that's fine — Bond will infer structure from the content during synthesis.

**Screenshots & links:** Drop them in naturally. Screenshots get saved to media and tagged with the meeting context. Links are preserved as references. The next text message after a screenshot/link becomes its annotation.

**What Bond does quietly in the background:** Nothing during the meeting. No API calls, no processing. Just accumulating messages in the session with a `meeting` flag. The intelligence happens at the end.

### 3. End — Synthesis

```
/meeting end
```

Bond:

1. **Collects all notes** from the meeting session (every message since `/meeting start`)
2. **Pulls Sense context** for the meeting time window:
   - Active apps and windows (Zoom, Figma, browser tabs)
   - Participant names from Zoom/Meet UI (OCR'd from screen)
   - URLs visited during the meeting
   - Figma file names visible on screen
   - Slack channels that were active
3. **Synthesizes** everything into a structured summary via a single Claude call
4. **Presents the summary** for review before taking any action

---

## Summary Format

The synthesis produces a structured document:

```markdown
# Meeting: [Title]
**Date:** April 13, 2026 · 9:00–9:45 AM
**Attendees:** Matt, Sarah, Joen (inferred from Sense)
**Context:** Zoom call, referenced Figma file "Editor Redesign v3", visited github.com/a8c/editor

## Key Points
- Discussed the new navigation patterns for the editor sidebar
- Sarah presented two options for the header treatment
- Team leaning toward collapsible sections over tabs

## Decisions
- Going with option B for the header (collapsible)
- Will keep the old sidebar accessible via toggle during transition

## Action Items
- [ ] Update the nav prototype by Friday — @shaun
- [ ] Review color system tokens for consistency — @matt
- [ ] Schedule follow-up with content team — @sarah

## Open Questions
- Are we keeping keyboard shortcuts for the old navigation?
- What's the timeline for deprecating the legacy sidebar?

## References
- [Editor Redesign v3](figma.com/file/abc123) — shared during call
- [github.com/a8c/editor#142](https://github.com/a8c/editor/pull/142) — mentioned in chat
```

### Presentation

Bond shows the summary in an artifact card with actionable buttons at the bottom:

- **Save to project** — writes the markdown to the project's folder and adds it as a resource
- **Create todos** — shows extracted action items as proposed todos, user confirms which ones to create
- **Add journal entry** — saves a condensed version to the journal
- **Copy to clipboard** — for pasting into a P2, Slack, or doc

The user reviews, edits if needed, then chooses what to do with it.

---

## Technical Design

### Skill File: `~/.bond/skills/meeting/SKILL.md`

This is a skill, not a daemon feature. It lives entirely in the SKILL.md instructions — no new daemon code, no new database tables, no new RPC methods. It uses existing Bond primitives:

- **Chat messages** — the notes are just regular messages in the session
- **Sense CLI** — `bond sense search` and `bond sense timeline` for screen context
- **Project CLI** — `bond project show`, `bond project resource add`
- **Todo CLI** — `bond todo add --project <name>`
- **Journal CLI** — `bond journal add --project <name>`
- **Media CLI** — screenshots dropped in chat are already handled by the media system

### Skill State Management

The skill needs to track meeting state (started, in-progress, ended). Since skills are stateless between messages, the state is managed through **the conversation itself**:

- `/meeting` or `/meeting start` → Bond notes the start time in its response, enters meeting mode
- Each subsequent message is a note (Bond stays silent)
- `/meeting end` → Bond knows to synthesize everything since the start message

**How "silent mode" works:** The SKILL.md instructs Bond that between `/meeting start` and `/meeting end`, it should:
1. Acknowledge each note with at most a tiny inline marker (e.g., `·` or nothing at all)
2. Not generate substantive responses
3. Not make any tool calls
4. Treat every message as a note to accumulate

This is a prompt-level behavior change, not a code-level one. The agent is instructed to be quiet.

### Sense Integration

At `/meeting end`, the skill instructs Bond to run:

```bash
# Get timeline of what was on screen during the meeting
bond sense timeline 9:00am-9:45am

# Search for specific context
bond sense search "zoom"
bond sense search "figma"

# Get app usage during the window
bond sense apps today
```

The Sense data enriches the summary with:
- **Attendees** — OCR'd from Zoom/Meet participant panels
- **Referenced files** — Figma files, GitHub PRs, docs visible on screen
- **URLs** — browser tabs that were open/visited
- **App switching patterns** — shows what was being demoed or screen-shared

### Synthesis Prompt

The skill provides a detailed prompt for the synthesis step. Bond already has Claude access — this is just a well-structured system prompt instruction in the SKILL.md:

```
When the user says `/meeting end`, gather all messages since `/meeting start` as raw notes.
Then call `bond sense timeline` for the meeting time window.
Synthesize into the following structure:
- Title (infer from notes if not provided at start)
- Date and time range
- Attendees (from Sense screen context — look for video call participant names)
- Key discussion points (from notes, expanded with Sense context)
- Decisions (from `>` prefixed notes, or inferred from language like "we decided", "going with")
- Action items (from `!` prefixed notes, or inferred from "need to", "will do", "should")
- Open questions (from `?` prefixed notes, or inferred from unresolved discussions)
- References (URLs, Figma files, PRs from both notes and Sense)
```

### Project Routing

After synthesis, Bond suggests a project:

1. If `/meeting --project X` was specified, use that
2. If the current chat is linked to a project, suggest that
3. Otherwise, scan existing projects and suggest the best match based on meeting content
4. If no match, offer to create a new project

**Saving to a project:**
```bash
# Write the summary markdown
# File goes to: <project-root>/meetings/YYYY-MM-DD-<slug>.md
mkdir -p <project-root>/meetings
# Write file

# Add as project resource
bond project resource add <project> file <path> "Meeting: <title>"

# Create todos linked to the project
bond todo add "Update the nav prototype by Friday" --project <project>
bond todo add "Review color system tokens" --project <project>
```

The `meetings/` subfolder convention keeps meeting notes organized within a project without cluttering the root.

---

## Implementation

### What to build

Just the SKILL.md file. That's it.

The entire feature is a skill — a detailed set of instructions that changes Bond's behavior within a conversation. No daemon changes, no database migrations, no new RPC methods, no new UI components.

This is the right call because:
- Meeting notes are session-scoped (start → capture → end → output)
- All the primitives already exist (Sense, todos, projects, journal, media)
- The skill system is designed exactly for this: behavioral modes that compose existing tools
- Shipping a skill is a 0-code change — write the SKILL.md, restart the daemon, done

### Skill structure

```
~/.bond/skills/meeting/SKILL.md
```

**Frontmatter:**
```yaml
---
name: meeting
description: Live meeting note-taking with Sense-enriched summaries. Captures notes during calls, then synthesizes with screen context into structured summaries with project routing and todos.
argument-hint: "[title or context] [--project <name>]"
---
```

**Body sections:**
1. Activation — trigger on `/meeting` or natural language ("I'm about to hop on a call")
2. Phase 1: Start — parse args, acknowledge, enter quiet mode
3. Phase 2: Capture — behavioral rules for silent accumulation
4. Phase 3: Synthesis — end trigger, Sense data collection, structured output
5. Phase 4: Routing — project matching, todo creation, journal entry, file save

### The silent mode challenge

The hardest part of this skill is making Bond shut up. The agent naturally wants to respond to every message. The SKILL.md needs to be emphatic:

```
CRITICAL: Between /meeting start and /meeting end, you are in SILENT CAPTURE MODE.
- Do NOT generate responses to user messages
- Do NOT make tool calls
- Do NOT analyze or process notes in real-time
- Your ONLY response to each message should be nothing, or at most a single character acknowledgment
- The user is on a call. They cannot read your output. Silence is the feature.
```

This is a prompt-level instruction, so it's not 100% guaranteed. But skills already change Bond's behavior dramatically (see: brainstorm's phased approach). The key is being forceful and repetitive in the instruction.

**Fallback:** If Bond does respond verbosely to a note, it's annoying but not breaking. The notes still accumulate in the session and synthesis still works. The worst case is some extra messages to scroll past.

---

## Future Ideas (Out of Scope)

These came up during brainstorming and are worth tracking but not building now:

### Meeting Mode UI
A dedicated compact, always-on-top window with minimal chrome — just a text input and a running bullet list. Like a scratchpad that happens to be smart. This would require Electron window management changes (new BrowserWindow, always-on-top flag, compact layout).

### Quiet Nudges
During silent mode, Bond occasionally surfaces subtle inline prompts: "Who owns this?" or "Is this a decision or still open?" Requires careful UX — any nudge during a call is a potential distraction.

### Passive Transcript
If Zoom/Meet generates a transcript, paste it in after `/meeting end` and Bond cross-references it with your live notes — filling gaps, correcting attributions, catching things you missed. This is additive and could be a simple "paste your transcript here" step in the synthesis phase.

### Meeting Memory
Bond remembers past meetings on the same topic. "Last time you met about the editor redesign (March 28), these action items were still open..." This already partially works via Sense debriefs — a meeting summary saved as a journal entry or project resource is searchable via `bond sense search`.

### Audio Capture
The nuclear option. Use macOS audio capture APIs to record meeting audio, transcribe locally via Whisper, and combine with typed notes (the Meetily/Granola approach). Massive scope increase, privacy implications, but would make the feature dramatically more powerful. If pursued, should be a separate plan.

---

## Open Questions

- **Silent mode reliability:** How well does the prompt-level "be quiet" instruction actually work in practice? Needs real-world testing. If it fails frequently, we may need a code-level flag on the session that suppresses agent responses.

- **Sense time window accuracy:** The user says `/meeting end` but didn't say exactly when it started (if they just typed `/meeting` without checking the clock). Should Bond use the timestamp of the `/meeting` message as the start time? That's the simplest and most reliable approach.

- **Screenshot handling:** When the user drops a screenshot mid-meeting, it goes through the normal image flow. Should the skill explicitly tag these images with meeting context, or is the session association sufficient?

- **Multiple meetings per session:** Should the skill support multiple `/meeting start` ... `/meeting end` cycles in a single chat session? Probably yes — a user might have back-to-back calls in the same Bond session. Each cycle should produce its own summary.

- **Calendar integration:** Sense can see calendar notifications on screen. Could Bond infer the meeting title, attendees, and scheduled time from a calendar popup? Possible via Sense OCR but fragile. Worth exploring after the core skill ships.
