# Agents that write, and agents that run in the background

Two orthogonal upgrades to Bond's existing agent system. Today every agent is
**read-only** and **synchronous** (an in-turn, blocking `consult_agent` tool
call). We want an agent to optionally be **write-capable** and **asynchronous**.

**Mathis** — the code-builder — is the first agent that needs both. **Felix**
and **Q** stay read-only and synchronous. Nothing about the existing roster
changes; we add two opt-in axes.

---

## 1. Where we are today (code-grounded)

- `consult_agent` is a **synchronous, in-turn tool** (`agents/tools.ts:61`). It
  blocks the turn — Bond `await`s the whole child session (`run-agent.ts:85`) —
  and a new user send **aborts** the turn (`turns.ts:93-100`), which kills the
  child (`run-agent.ts:82`). This is why "Bond gets tied up" and why talking to
  him mid-consult cancels the work.
- The child runs in an **isolated in-memory Pi session rooted at `homedir()`**
  (`run-agent.ts:63-74`). No git, no worktree. Tools = read-only base
  (`read/grep/find/ls`) plus web only; "write-capable tools are deliberately
  absent and must never be added" (`run-agent.ts:24`, `shared/agents.ts:31`).
  It returns the final report text only.
- Config lives in `AgentSettings` (`model/thinking/report/policy/leash/
  instructions/tools`) from `AGENT.md` frontmatter + a settings override layer;
  `normalizeAgentSettings` filters `tools` down to the web-only grant list.

**Safety infrastructure already built and reusable:**

| Capability | Where | Reuse for |
|---|---|---|
| Path-scoped writes (`scoped` / `allowedPaths`) | `pi/runtime.ts` | Folder control for a write-agent |
| Persisted approval registry | `approvals.ts` | "Ask before this action" |
| Persisted question registry | `questions.ts` | Agent asks a question mid-run |
| Single allow/ask/block gate | `mcp/policy.ts` `decideMcpCall` | The write-agent's approval gate |
| Leash timer + parent-abort | `run-agent.ts` | Wall-clock runaway cap |
| Broadcast + multi-device sync | `turns.ts`, `server.ts` | Live run status to every client |
| Tray notification | `main/tray.ts` | Non-interrupt "done / needs input" |
| "Every run leaves a row" | `memory/ledger.ts` | Never fail silently |
| Off-turn background queue | `memory/service.ts:349` | The async template (but see below) |

**The gap:** the memory queue (`enqueueMemoryTask`) is an **in-memory promise
chain**. It runs off-turn and survives after a turn, which proves background
work is possible — but a daemon restart loses it. A minutes-long build needs a
**persisted** run store, not a promise chain.

---

## 2. Change A — write-capable agents

**A1. A new opt-in axis, not a removed invariant.** Add `workspace:
'read-only' | 'write'` to the agent definition/settings (default `read-only`).
Felix and Q are untouched. The three enforcement points that hard-code
read-only today (`shared/agents.ts`, `definition.ts`, `run-agent.ts`) become
*conditional on this flag* rather than absolute.

**A2. Folder control = a git worktree per run.** A write-agent's `cwd` is a
fresh **git worktree on its own branch off `main`** — not `homedir()`, not the
tree the app runs from. It may write **inside the worktree only**; `.git` and
everything outside are read-only (OpenAI Codex's `workspace-write` +
protected-paths model). This reuses the `scoped`/`allowedPaths` idea, anchored
to a throwaway worktree so the running Bond's files are never touched.

Model the run's target as a **workspace descriptor**, not an implicit "the Bond
repo": `{ repoRoot, isolation: 'worktree' | 'in-place', branch }`. Phase 1
**hardcodes it to `{ Bond repo, worktree }`** and the worktree is *required* —
but the descriptor is the seam for later:
- **other repos** — point an async agent at the `studio` repo, or any project,
  not just Bond's own source;
- **in-place + git control** — once trusted, relax the worktree requirement so
  an agent works directly in a main folder and runs git itself. This is an
  additional tool grant (`git`) + `isolation: 'in-place'`, gated behind the
  same trust/approval axis, never the Phase 1 default.

**A3. Tools = read base + write/edit + a command runner with a broad
pre-approved allowlist.** The worry to avoid is Mathis stalling on a permission
prompt every few seconds. So the model is **not** "approve each command" — it's:

- Mathis's definition declares a **command allowlist** (his working set:
  `npm install`, `npm run test:run`, `npm run build`, `vue-tsc`, `git`
  add/commit/branch *inside the worktree*, etc.). Approved **once** via the
  existing runner-hash mechanism (`definition.ts:218`, `evidence.ts`) — at run
  time these **never prompt**. Because he's sealed in a throwaway worktree, this
  allowlist can be **generous**; the worktree is the safety boundary, not the
  command list.
- A small **hard denylist** always blocks the commands that reach *past* the
  worktree into the real system — daemon lifecycle (`bin/bond start/stop/
  restart/dev`), process kills, launching the app, writes outside the worktree
  root. These are dangerous precisely because the worktree isolates *files* but
  **not** the daemon socket, DB, or port (§4).
- A command that's on neither list doesn't fail the run — it **parks as
  `needs-input`** (§B6): the run pauses, you're pinged, you approve/deny, it
  resumes. Pausing ≠ failing, so Mathis is never "stuck and dead," just waiting,
  and you always know he's waiting.

**A4. Safety = two axes through one gate.** Sandbox tier (worktree-scoped
write) × approval policy (auto/ask/deny), evaluated in a single
`decideMcpCall`-style gate:
- edits **inside the worktree** → auto-approve (isolated + recoverable, like
  Claude's `acceptEdits` inside the working dir);
- anything **outside the worktree**, arbitrary command, or network write → ask.
- Must-run checks go in a **pre-tool hook**, not the approval callback —
  auto-approved tool calls never reach the callback (Claude Agent SDK gotcha).

**A5. The agent never applies to the real project.** Output is a **branch +
diff**. "Bond is the only hands that applies anything" holds at the *repo*
level even though the agent writes in its *worktree*. Applying is a separate,
human-gated step (§4).

**Resolved:** worktree **required** for Phase 1 (in-place + git control is a
later phase, per A2). Command safety = **generous pre-approved allowlist inside
the worktree + hard denylist for worktree-escaping commands + park-on-novel**,
so routine building never prompts and a novel command pauses rather than fails.

---

## 3. Change B — asynchronous agents

**B1. Decouple from the turn with a durable store.** New SQLite table
`agent_runs` + a per-run **append-only event log** (OpenHands-style event
sourcing; ~sub-20ms crash recovery is achievable). Status enum:
`queued / running / needs-input / succeeded / failed / cancelled`. On daemon
restart, reconcile by reload — not by keeping the process alive. This is the
*persisted* version of the memory queue.

**Must survive a daemon crash/restart** (confirmed requirement). On boot, the
worker scans for runs left `running` and recovers them: the **worktree persists
on disk** with its work-in-progress, so a run is never *lost*. Whether we
*resume the Pi session mid-thought* or *re-enter from the last checkpoint event*
is a Phase-2 implementation choice (resuming an LLM mid-tool-call is hard); the
durable guarantee is that we never drop a run silently or orphan a worktree —
an interrupted run comes back as `running` (resumed) or `needs-input`
("I restarted mid-build — continue or discard?"), never as a phantom.

**B2. A worker loop drains the queue** — one serialized loop on a `setInterval`,
exactly like `desk/worker.ts`. Start with a concurrency cap of 1–2 runs.

**B3. Bond initiates non-blocking.** A new tool `dispatch_agent` creates a run
row and **returns a run id immediately** — the fix for "tied up." Bond keeps
talking to you the moment the job is queued.

**B4. Tracking = push for edges, poll for reconcile.** The worker broadcasts an
`agent_run_changed` chunk (mirrors `desk.changed`) on every state change; a
status table answers "what's running" on reconnect. Bond can also call
`check_agent(runId)` on demand.

**B5. Completion is proactive.** The worker writes the final report + broadcasts
`done`, and Bond **surfaces it into the conversation without waiting for your
next message** — a completion card in the transcript ("Mathis finished chat
threads · tests green · Q approved · [View diff] [Apply] [Discard]") plus a tray
glyph when the app isn't focused.

This needs a genuinely new capability: **inserting a transcript row outside any
turn.** Today every message is minted inside the user-initiated turn lifecycle
(`turns.ts`); approval/question cards are inserted *within* a turn. A background
completion arrives when **no turn is active**, so the worker needs a path to
append a message + broadcast it with no turn running. The broadcast plumbing
already exists (`server.ts`); what's new is calling it outside `startBondTurn`.
Guard it: if a user turn is mid-flight, the card queues and lands when the turn
settles, so a completion never clobbers an in-progress reply.

**B6. A question mid-run parks as `needs-input`.** Reuse the
`ask_user_question` shape, but scope the pending question to a **`runId`**
instead of a `turnId` (`questions.ts` is turn-scoped today). Persist it,
surface it through the same non-interrupt channel, resume on answer. Keep any
writes *before* the question idempotent (the run may re-enter the node on
resume).

**B7. Failure = per-error-class retry, then surface.** 0 retries for
validation/auth/permission, 2–3 for transient (timeout/5xx), 0 for a
policy/safety block. Then mark the run `failed` with an `error_class` + message.
Every run leaves a row (memory-ledger discipline) — never a silent swallow.

**B8. Runaway prevention — four caps + loop detection.**
- wall-clock leash (exists, `AgentSettings.leash`, 30–900s);
- **max steps** (~50 model turns);
- **token / cost budget** per run (step caps don't track spend);
- **loop detection**: stop when a fingerprint of `(last action + last result)`
  repeats ≥3×.
- Hard kill = cancel the run + tear down its worktree.

**Resolved:** durable store (must survive a crash/restart); completion is
**proactive** — Bond surfaces it into the conversation, not on your next turn.

---

## 4. The apply flow (from the walkthrough)

Nothing lands automatically. Mathis produces a branch + diff; then:

1. Bond can have **Q review the diff** (reviewer ≠ builder — the whole reason Q
   stays separate).
2. **Risk tier decides how applying works:**
   - **UI / renderer-only** → low risk; safe to apply.
   - **Daemon-only (no protocol change)** → Bond can rebuild + restart its own
     daemon; launchd resurrects it and the app reconnects in place. The current
     conversation ends and comes back on the new version.
   - **Protocol / shared types / DB migration** → hand to Shaun to apply at a
     break. The app must reload and data may migrate. Never mid-conversation.
3. **The worktree isolates files but NOT the daemon socket, the SQLite DB, or
   port 3113.** So a running agent must **never launch the app or restart the
   daemon** — tests only, on the in-memory DB. Applying is the one moment those
   singletons change, and it's gated on a human.

---

## 5. Transparency & control surface

**5a. In-conversation activity (needs a rethink).** Today the transcript's only
activity surface is the per-turn `TurnActivity` row — tool-call summaries scoped
to one turn, which collapse when the turn ends. Background agents **outlive
turns**, so they need presence the turn-scoped row can't give:

- A **persistent ambient indicator** while any run is active — e.g. a
  "**2 agents working**" chip in the conversation chrome (near the composer /
  header), always visible, click-through to the Tasks panel. This is the
  standing "something is happening in the background" signal, distinct from a
  turn's transient activity row.
- **Background runs surface as their own message kind** in the transcript — a
  new `meta/agent-run` card (sibling to `meta/activity`, `meta/approval`,
  `meta/question`), not folded into a turn's activity. It streams live while the
  run works and settles into the completion card (§B5) with its controls.
- Keep the two activity systems **distinct**: `meta/activity` = "what Bond did
  during *this* turn"; `meta/agent-run` = "a background job that spans turns."
  Conflating them is how the ambient work would get buried in a collapsed row.

**5b. Tasks panel.** A new right panel (like Desk/Sense): each run shows status,
a **live event log** (reuse the `TurnActivity` streaming component), a **diff
view**, and controls: **stop/cancel**, **answer question**, **apply/discard**
the branch. Built on the same broadcast + persisted-row + reconnect-reconcile
pattern as approvals/questions.

**5c. CLI mirror** `bond agent` (`status` / `list` / `logs` / `cancel` /
`answer`), exactly like `bond desk` is Desk's surface.

---

## 6. Phase plan

**Implementation sequencing note (2026-07-22):** Phase 1 is split at the
remote-write boundary. The local tranche includes Mathis, managed worktrees,
the command policy, and the `needs-input` command-question/checkpoint mechanics
originally grouped under Phase 2, because a parked novel command must be able
to resume the same run before write-capable execution is safe to ship. GitHub
authentication, push/draft-PR publishing, Q comments, and apply remain a
separate next slice behind an interface/config boundary; no personal `gh`
session is used by the local tranche.

- **Phase 0 — Async spine.** `agent_runs` table + event log + worker loop +
  `dispatch_agent`/`check_agent` tools + `agent_run_changed` broadcast +
  crash-recovery on boot. Prove it with a trivial *read-only* background task.
  No writes yet.
- **Phase 1 — Write in a worktree.** `workspace: 'write'` flag, worktree per run
  (required), write/edit tools + the generous allowlist, branch + diff output,
  no auto-apply. Define **Mathis**. Includes the **minimal proactive completion
  card** (§B5) — inserting a transcript row outside a turn — because "Bond tells
  me when it's done" is a hard requirement, not polish.
- **Phase 2 — Robustness.** `needs-input` park/resume (runId-scoped questions,
  incl. the novel-command pause), per-error-class retry, the four runaway caps +
  loop detection.
- **Phase 3 — Surface.** The conversation activity redesign (persistent
  "N agents working" chip + `meta/agent-run` card, §5a), Tasks panel + controls,
  tray notification, `bond agent` CLI.
- **Phase 4 — Apply flow.** Q review + risk-tier classification + the
  daemon-safe rebuild/restart path.
- **Phase 5 — Beyond the Bond repo.** Target arbitrary repos (studio, any
  project) via the workspace descriptor; then optional `isolation: 'in-place'`
  + a `git` tool grant for trusted agents that work in a main folder and control
  git themselves.

---

## 7. Prior art worth stealing

- **Git worktree per background agent** (Cursor, Conductor, Vibe Kanban) —
  cheapest strong isolation without a VM.
- **Two-axis permission** (sandbox tier × approval policy) with protected paths
  and must-run checks in a pre-tool hook (Claude Agent SDK, OpenAI Codex).
- **PR/diff handoff, never auto-merge** (Conductor; Gas Town's "Refinery" merge
  queue).
- **Durable job rows + append-only event log**, resume by reload (OpenHands
  event sourcing; BullMQ job shape).
- **`needs-input` as a persisted, park-and-resume state** (LangGraph
  `interrupt`/`Command`; Bond's own approval/question registries).
- **Four hard caps + fingerprint loop detection**; on any cap, STOP or ESCALATE.
- **Route background needs-input through a non-interrupt channel** — the #1
  background-agent failure is a paused agent whose prompt never reached the user.

Sources: cursor.com/blog/agent-best-practices · code.claude.com/docs/en/agent-sdk/permissions ·
learn.chatgpt.com/docs/agent-approvals-security · langchain-ai.github.io/langgraph/concepts/human_in_the_loop ·
docs.bullmq.io/guide/retrying-failing-jobs · anthropic.com/engineering/multi-agent-research-system ·
conductor.build · github.com/OpenHands/software-agent-sdk
