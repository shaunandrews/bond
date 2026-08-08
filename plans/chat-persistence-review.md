# Chat persistence: architecture review and data-loss risks

This document describes how Bond stores chat sessions and messages, why data can disappear (including during local development with HMR), and practical ways to reduce that risk.

## End-to-end data flow

### Where chats live

| Layer | Responsibility |
|--------|----------------|
| **SQLite (`messages` table)** | Source of truth for persisted transcript. Rows are ordered by `position`. Session rows live in `sessions`. |
| **Renderer (`useChat`)** | Holds the active transcript in memory (`messages`), streams updates from the daemon, and calls `saveMessages` to sync to SQLite. |
| **localStorage** | Not the primary store. Used for emergency backup (`bond:msg-backup:<sessionId>`), activity bar snapshots, and the active session id (`bond:activeSessionId`). |

Path: **Renderer → Electron IPC → main process `BondClient` → Unix socket JSON-RPC → daemon `session.saveMessages` → `sessions.saveMessages` in `src/daemon/sessions.ts`.**

### Session list vs. message list

- **Sessions** are loaded with `useSessions().load()` → `session.list`. The **active session id** is stored in `localStorage` under `bond:activeSessionId` and updated when the user selects a chat.
- **Messages** for the visible session are loaded in `useChat.loadSession(sessionId)` via `getMessages`, unless a special in-memory path applies (background buffer or HMR — see below).

So “losing an entire chat” usually means either the **session row** was deleted, the **list failed to load** from the daemon, or the **UI is pointing at a different/empty session**. “Losing messages” usually means **SQLite never received a successful save**, or **a later read overwrote the UI with older DB state**.

## How `useChat` persists messages

Implementation: `src/renderer/composables/useChat.ts`.

### Conversion and guards

- UI messages (`Message`) are converted to wire/DB rows (`SessionMessage`) with `toSessionMessages` before every save.
- On load, `fromSessionMessages` **drops empty thinking rows** (`kind === 'thinking'` with no trimmed text). That is intentional for stale DB rows after interrupted queries, but it can look like “missing” thinking lines after a crash.

### When saves happen

1. **After the user sends a message** — `persistMessagesFor` is **awaited** right after the user message and thinking placeholder are appended. This is the strongest guarantee that the user’s text reached the DB before the agent run proceeds.
2. **During streaming** — `schedulePersistFor` throttles saves to about **once every 2 seconds** for assistant text and tool meta messages.
3. **On important chunk types** — `flushPersistFor` (immediate) runs on `result`, `raw_error`, `query_end` handling, and cancel paths.
4. **On session switch** — `flushPersistFor` runs for the previous session before loading the next (so switching away forces a flush of the session you leave).

### Background sessions

If you switch to another session while the previous one is still **busy** (streaming), the old session’s messages are **deep-copied** into `backgroundMessages`. When you switch back, that buffer is applied instead of reading from the DB, so in-flight UI state is preserved. `loadSession` also **awaits `lastPersistPromise`** for the target session before reading from the DB to avoid a race where `query_end`’s persist has not finished.

### Daemon-side protection: `saveMessages`

In `src/daemon/sessions.ts`, `saveMessages`:

- **Refuses to run** if the session id does not exist (`return false`).
- **Blocks** a save that would drop more than **five** messages compared to the existing row count for that session (`loss > 5`). This blocks catastrophic overwrites from partial renderer state; it also means a **legitimate** shrink of more than five messages (rare in normal use) would be rejected until the client sends a coherent full list.

When `saveMessages` returns `false`, the renderer logs a warning and writes to **localStorage** backup if possible.

### localStorage backup and restore

- **During streaming**, an interval (about **15s**) writes `bond:msg-backup:<sessionId>` for busy sessions.
- **On persist failure**, the same key is used.
- **`stashToLocalStorage`** runs on connection loss (`App.vue`) and on `beforeunload` / `onUnmounted`, and backs up **current and background** sessions.
- **`restoreFromBackupIfNeeded`** compares backup vs DB by **message count** and **total text length** (with a small slack). If backup wins, it **pushes** the backup into the DB via `saveMessages` and removes the key.

Restore is invoked from `App.vue` on initial load (when not skipping for HMR) and on **connection restored** for the **active** session only.

## HMR (Vite hot reload) behavior

`useChat` uses `import.meta.hot` to:

1. **Stash** `messages`, `backgroundMessages`, busy sets, activity maps, and queued messages on `hot.dispose`.
2. On dispose, it **clears persist timers** and fires **fire-and-forget** `persistMessagesFor` calls, then writes **localStorage** backups synchronously (because async persist may not finish before unload).
3. On reload, if there is stashed message state, it **re-persists** to the DB in an async IIFE so SQLite catches up.

`App.vue` avoids clobbering in-flight UI: if `chat.messages` is non-empty and `currentSessionId` is set after reload, it **skips** `loadSession` on mount (`hasHmrState`), so the in-memory/HMR-restored transcript is not replaced by an older DB read.

### HMR-related risk

If **HMR state is lost** (e.g. full page reload instead of module HMR, devtools “disable cache” + hard reload, or a crash before `hot.data` is written), the app falls back to **`loadSession` from DB** and **`restoreFromBackupIfNeeded`**. Anything that only existed in memory and never reached the DB or localStorage can still be lost.

## Other notable failure modes

1. **`saveMessages` blocked** — Data stays in memory; backup may exist from a later failed save. If an **older** backup is smaller than DB, restore might not run; user sees DB state (possible confusion).
2. **Daemon/session missing** — If `saveMessages` returns false because the session row is missing, persistence fails until the session exists (should be rare after normal `createSession`).
3. **`repersistAll` on reconnect** — Re-persists the **current** session and **background** buffers only; it does not iterate every session id in the app.
4. **Quick chat window** (`QuickChat.vue`) — Uses `useChat` but does not duplicate `App.vue`’s `beforeunload` / connection hooks. Behavior depends on whether the window is closed in a way that runs cleanup and whether the same backup paths apply; worth remembering if testing persistence from quick chat only.
5. **Queued messages** — Stored only in memory (`queuedMessages`); not in SQLite until sent. A hard crash could lose the queue even if the last completed turn was saved.

## Ideas to reduce data loss while developing Bond

These are **workflow and product** mitigations; they align with the current architecture rather than requiring immediate code changes.

### Workflow (high impact)

1. **Prefer soft HMR over full reload** — When editing renderer code, save files so Vite can HMR `useChat.ts` / `App.vue` without reloading the whole page. A **full reload** or **closing the window** during an active stream skips `hot.dispose` state and relies on DB + backup only.
2. **Watch the daemon** — If you restart the daemon or run `bond rebuild` while chatting, expect a **WebSocket disconnect**. After reconnect, the app runs `repersistAll` and backup restore for the **active** session. Avoid switching sessions until reconnect completes if you care about that transcript.
3. **Avoid switching chats rapidly mid-stream** unless needed — The code is designed to handle it (background buffer + flush on leave), but it is a complex path and more surface area for edge cases.
4. **Check the console** — Warnings like `[bond] persistMessagesFor failed` or `[bond] saveMessages blocked` indicate memory-only or blocked writes; treat them as “this session may be out of sync with SQLite.”

### Optional hardening directions (for future work)

- **Flush on `document.visibilitychange`** — When the window hides, call `stashToLocalStorage` + `flushPersistFor` for the active session to narrow the gap before OS sleep or aggressive tab throttling.
- **Restore backup for all sessions on startup** — Today restore is focused on the active session at launch; background sessions with only backup data might be less covered.
- **Surface persist failures in UI** — A small non-blocking indicator when `saveMessages` returns false would make silent degradation visible during dev.
- **Separate dev data directory** — Running against a copy of `bond.db` or a dedicated profile avoids anxiety about corrupting long-lived chats when testing destructive daemon changes (CLI / env dependent).

## Key source references

| Area | Location |
|------|-----------|
| Renderer persistence, HMR, backup | `src/renderer/composables/useChat.ts` |
| Mount / reconnect / HMR skip | `src/renderer/App.vue` |
| Active session id | `src/renderer/composables/useSessions.ts` (`bond:activeSessionId`) |
| SQLite save + loss guard | `src/daemon/sessions.ts` (`saveMessages`) |
| JSON-RPC | `src/daemon/server.ts` (`session.saveMessages`, `session.getMessages`) |
| IPC | `src/main/index.ts` (`session:saveMessages`, `session:getMessages`) |

---

*Written as a technical review of the chat persistence pipeline; behavior described matches the codebase at the time of writing.*
