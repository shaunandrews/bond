# Bond Jobs — Scheduled & Looping Tasks

A lightweight job system that lets Bond schedule future actions and monitor ongoing processes without the user initiating a message.

---

## Why

Bond is stateless between messages. When it says "I'll check on that operative" or "I'll remind you at 3pm," it's lying — there's no mechanism to follow through. Jobs fix this by giving Bond a way to register deferred work that the daemon executes autonomously.

Two primitives:

- **Scheduled** — do X at time Y. Fire-and-forget. Cron jobs, reminders, briefings.
- **Looping** — keep doing X every N seconds until condition Z. Monitoring, polling, watching.

A loop is just a scheduled job that re-schedules itself, so both share the same underlying table and execution engine.

---

## Data Model

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,         -- which chat receives the output
  type TEXT NOT NULL DEFAULT 'once', -- 'once' | 'loop'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

  -- Timing
  run_at TEXT NOT NULL,              -- ISO timestamp for next execution
  interval_ms INTEGER,              -- loop interval (null for once)

  -- What to do
  action TEXT NOT NULL,              -- shell command to run (cheap check)
  prompt TEXT,                       -- AI prompt to run after action (smart check), null = no AI call
  condition TEXT,                    -- natural language stop condition for loops, null = run max_runs times

  -- Constraints
  max_runs INTEGER NOT NULL DEFAULT 1,  -- 1 for scheduled, N for loops
  max_cost_usd REAL,                -- budget cap for any AI calls
  runs_count INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,

  -- Results
  last_result TEXT,                  -- output from most recent run
  last_run_at TEXT,                  -- when it last executed

  -- Metadata
  label TEXT,                        -- human-readable name ("Monitor operative", "Morning briefing")
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status_run_at ON jobs(status, run_at);
```

---

## Execution Engine

### Daemon tick loop

A `setInterval` in the daemon server that runs every 30 seconds:

```ts
// In server.ts init
setInterval(() => tickJobs(onSessionSystem), 30_000)
```

`tickJobs` queries for due jobs:

```sql
SELECT * FROM jobs
WHERE status = 'pending'
  AND run_at <= datetime('now')
ORDER BY run_at ASC
LIMIT 5
```

For each due job:

1. Set `status = 'running'`
2. Execute the `action` (shell command) — capture stdout
3. If `prompt` is set, run a short `runBondQuery` with:
   - The action's output as context
   - The job's prompt as the query
   - Tight constraints: read-only tools, low max_tokens
   - Budget check against `max_cost_usd`
4. For loops with a `condition`: include the condition in the prompt, ask the AI to evaluate whether it's met (returns boolean + summary)
5. Push result to the session via `onSessionSystem(sessionId, text)`
6. Update `runs_count`, `last_result`, `last_run_at`, `total_cost_usd`
7. If loop and condition not met and `runs_count < max_runs`: set `run_at = now + interval_ms`, `status = 'pending'`
8. Otherwise: set `status = 'completed'`

### Two tiers of execution

**Cheap check** (prompt is null):
- Just run the shell command, push raw output to session
- Zero AI cost
- Good for: `bond operative show <id>`, `gh pr status`, `curl health-endpoint`

**Smart check** (prompt is set):
- Run the shell command, then pass output to a short AI query
- The AI interprets the output, evaluates conditions, writes a human summary
- Costs tokens but can reason about fuzzy conditions
- Good for: "Has the PR gotten critical feedback?", "Summarize what the operative did"

### Condition evaluation for loops

When a loop has a `condition`, the smart check prompt is structured:

```
You are evaluating whether a monitoring condition has been met.

Condition: "{condition}"

Current output from the check command:
---
{action_stdout}
---

Respond with JSON: { "met": true/false, "summary": "brief explanation" }
If met, the summary should describe what happened.
If not met, the summary should describe the current state.
```

This is a small, focused query — haiku-tier, ~200 tokens output. Cheap.

---

## CLI Interface

```
bond job schedule --in 5m "bond operative show 825b4a74"
bond job schedule --at "2026-04-08T08:00" "bond sense today" --prompt "Summarize my day"
bond job schedule --at "8am" --repeat daily "bond sense today" --prompt "Morning briefing" --label "Morning briefing"

bond job watch "bond operative show 825b4a74" \
  --every 60 \
  --until "status is completed or failed" \
  --prompt "Summarize what the operative did when it finishes" \
  --label "Monitor operative"

bond job ls
bond job show <id|number>
bond job cancel <id|number>
bond job clear              -- remove completed/failed jobs
```

Shorthand aliases that Bond (the AI) would use conversationally:

```
bond job watch "bond operative show X" --every 60 --until "operative is done"
bond job remind --in 30m "Check if the deploy succeeded"
```

### Argument details

- `--in <duration>` — relative time: `5m`, `1h`, `30s`
- `--at <time>` — absolute time: ISO timestamp, or shorthand like `8am`, `3:30pm`, `tomorrow 9am`
- `--every <seconds>` — loop interval
- `--until <condition>` — natural language stop condition (implies loop)
- `--prompt <text>` — AI prompt to run after the action
- `--max-runs <n>` — hard cap on iterations (default: 1 for schedule, 50 for watch)
- `--budget <usd>` — max AI cost (default: $0.50)
- `--label <text>` — human-readable name

---

## AI Integration

### System prompt addition

```
JOBS — SCHEDULED & LOOPING TASKS:
Bond can schedule future actions and monitor ongoing processes.
- `bond job schedule --in <duration> "<command>"` — run a command later
- `bond job schedule --at <time> "<command>" --prompt "<AI prompt>"` — run + AI summary later
- `bond job watch "<command>" --every <seconds> --until "<condition>"` — poll until done
- `bond job ls` — list active jobs
- `bond job cancel <id>` — cancel a job
Use jobs when you promise to "check on" something, monitor an operative, set reminders,
or schedule recurring tasks. Don't promise to check on things without creating a job.
```

That last line is key — it closes the honesty gap.

### How Bond uses it

When spawning an operative:
```
bond job watch "bond operative show 825b4a74" \
  --every 60 \
  --until "status is completed or failed" \
  --prompt "The operative finished. Summarize its result for the user." \
  --label "Monitor: Context Gauge"
```

When the user says "remind me to review the PR at 3pm":
```
bond job schedule --at "3pm" "gh pr view 123 --json state,reviews" \
  --prompt "Remind the user to review this PR. Include its current state." \
  --label "PR review reminder"
```

Morning briefing:
```
bond job schedule --at "8am" "bond sense today && bond todo ls --filter pending" \
  --prompt "Give the user a morning briefing: summarize screen activity, list pending todos, note any deadlines." \
  --label "Morning briefing"
```

---

## Delivery — How Results Reach the User

When a job fires, the result is pushed to the originating session via `onSessionSystem(sessionId, text)`. This is the same mechanism operative completion notifications use.

### What it looks like in chat

A system message appears in the conversation:

```
┌─ Job: Monitor operative ─────────────────────┐
│ Operative "Context Gauge" completed.          │
│ Changed 7 files. Added ContextGauge.vue,      │
│ updated agent.ts, operatives.ts, ChatInput,   │
│ App.vue. All TypeScript compiles clean.       │
└───────────────────────────────────────────────┘
```

### Edge cases

- **Session is archived/deleted**: Job becomes orphaned. On next tick, detect missing session and cancel the job. Log a warning.
- **User is mid-conversation**: Queue the notification. Don't interrupt streaming. Deliver when the current query completes (or after a brief pause).
- **Daemon restarts**: Jobs persist in SQLite. On startup, recover pending jobs. Any job that was `status = 'running'` gets reset to `pending` (same pattern as operative recovery).
- **Multiple jobs fire at once**: Process sequentially to avoid overwhelming the session. Max 3 job executions per tick cycle.

---

## Safety & Constraints

- **No write permissions** for job-triggered AI queries. Read-only tools only (Read, Glob, Grep, WebSearch, WebFetch). The AI can observe and summarize, not modify.
- **Budget cap**: Default $0.50 per job lifetime. Configurable per job. Enforced before each AI call.
- **Max runs**: Loops default to 50 iterations. Hard ceiling of 500. Prevents runaway loops.
- **Auto-expire**: Any job older than 24 hours with no recent execution is auto-cancelled. Configurable.
- **Rate limiting**: Max 10 active jobs per session. Max 30 total active jobs.
- **Cheap checks first**: When possible, use the action output alone (no AI call). Only invoke the AI when a prompt is explicitly set.

---

## Implementation Order

1. **DB table + daemon tick loop** — The engine. Jobs table, 30-second interval, execute cheap checks (action only, no AI). Push raw output to session.
2. **CLI commands** — `bond job schedule`, `bond job watch`, `bond job ls`, `bond job cancel`, `bond job clear`.
3. **System prompt integration** — Teach Bond about jobs so it uses them naturally.
4. **Smart checks** — Add AI query execution for jobs with a `prompt`. Budget tracking, read-only enforcement.
5. **Condition evaluation** — Loop termination based on natural language conditions.
6. **UI** — Job list view in the sidebar or activity bar. Active job indicators. Maybe a small badge showing running job count.

Steps 1-3 are the MVP. The AI can schedule shell commands and get results pushed back. Steps 4-5 add intelligence. Step 6 is polish.

---

## Open Questions

- Should recurring jobs (daily briefing) be a separate `type: 'recurring'` with cron-like scheduling, or just a loop with a 24h interval? A loop with `max_runs: 365` and `interval_ms: 86400000` works but feels hacky. Cron expressions are more natural for calendar-based recurrence.
- Should job results also be persisted as session messages in the DB, or just pushed transiently? Persisting means they survive app restart and show in session history. Leaning yes.
- Should there be a "job template" system for common patterns (monitor operative, morning briefing, PR watch)? Or is the AI smart enough to construct the right CLI invocation each time?
