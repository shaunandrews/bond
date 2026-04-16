# Message Persistence — Session Switch Data Loss

> Fix for messages disappearing when switching between chats while a response is streaming.

## Problem

When switching away from a session mid-stream and switching back, messages are lost — often the entire assistant response and sometimes earlier messages too. The bug is reproducible with this flow:

1. Start a chat (session A), send a message, Bond starts responding
2. Switch to a different chat (session B), send a message, have a back-and-forth
3. Switch back to session A — Bond's response is gone, sometimes multiple messages are gone

## Root Cause Analysis

The data loss stems from a race condition in `useChat.ts` between the session switch mechanics, the streaming chunk handler, the throttled persist timer, and the busy-state tracking. There are multiple contributing issues.

### Issue 1: Background stash is conditional on busy state (PRIMARY)

In `loadSession()` (`src/renderer/composables/useChat.ts:521-523`):

```js
if (busySessions.value.has(oldSid)) {
  backgroundMessages.set(oldSid, messages.value.map(m => ({ ...m })))
}
```

If `query_end` arrives in the same tick as the session switch (or just before), `markIdle()` clears the busy flag. The stash condition fails. `messages.value` is then overwritten with the new session's messages. The old session's in-memory messages — including the streamed response — are gone. The DB may have a partial or stale version from an earlier throttled persist.

This is the most likely primary cause. The window is small but real: `query_end` → `markIdle()` → user clicks another session → `loadSession()` checks `busySessions` → false → no stash.

Worse: `loadSession` calls `await flushPersistFor(oldSid)` before the stash check (line 518). During this await, `query_end` can arrive and clear the busy flag. By the time we reach the stash check at line 521, the session is no longer busy.

### Issue 2: Throttled persist reads wrong message source after switch

`schedulePersistFor()` sets a 2-second timer. When it fires, `persistMessagesFor()` checks:

```js
const msgs = sessionId === currentSessionId.value
  ? messages.value
  : backgroundMessages.get(sessionId)
```

If the session switch happened between scheduling and firing:
- `currentSessionId.value` is now session B
- `messages.value` contains session B's messages
- `backgroundMessages.get(A)` might be undefined (if the stash from Issue 1 didn't happen)
- Result: persist for session A writes nothing → data lost

The same source-selection pattern exists in `startStreamingStash` (line 222-225), the periodic localStorage backup used for crash recovery. If the session switched, this backup also reads the wrong data.

### Issue 3: `saveMessages` guard silently blocks saves

In `sessions.ts:148-155`:

```js
const loss = existing.count - messages.length
if (loss > 5) {
  console.warn(`[bond] saveMessages blocked...`)
  return false
}
```

During streaming, the renderer creates and removes thinking messages, tool messages, and empty thinking blocks. The in-memory count can legitimately differ from the DB count. If the guard triggers, the save is silently blocked, and the DB retains stale data. When `loadSession` falls through to the DB read path, it loads the old version.

The guard was added to prevent crash-induced data loss, but it's now causing the exact problem it was designed to prevent — just in a different scenario.

### Issue 4: No subscription management on session switch

The daemon has `bond.subscribe` / `bond.unsubscribe` RPC methods for controlling which WebSocket clients receive chunks for which sessions. The `BondClient` exposes these methods. But **nothing in the main process or renderer calls them during session switches**. Subscription only happens implicitly inside `bond.send` (`server.ts:394`).

The preload (`src/preload/index.ts`) doesn't expose `subscribe`/`unsubscribe` at all. The main process (`src/main/index.ts`) doesn't handle them either. So the renderer has no way to manage subscriptions even if it wanted to.

This isn't directly causing data loss, but it means the daemon has no signal that the renderer cares about a session it's not actively sending to. It's a missing piece of the architecture that should be wired up as part of this fix.

### Issue 5: Overlapping `loadSession` calls (RACE)

`loadSession` is async with multiple await points. There's no cancellation or mutex. If the user clicks sessions rapidly (A → B → C), two `loadSession` calls can overlap:

1. `loadSession('B')` starts: `oldSid = 'A'`, awaits `flushPersistFor('A')`
2. While awaiting, user clicks C. `loadSession('C')` starts: `oldSid = 'A'` (captured before B's call changed it)
3. `loadSession('B')` resumes: stashes A's messages, sets `currentSessionId = 'B'`, loads B's messages into `messages.value`
4. `loadSession('C')` resumes: oldSid is 'A' (stale), **doesn't stash B's messages**. Sets `currentSessionId = 'C'`, overwrites `messages.value` with C's data
5. B's messages are gone — never stashed, never persisted.

The existing test for "rapid session switching (A → B → A)" doesn't catch this because it `await`s each `loadSession` sequentially.

---

## Fix Plan

### Fix 1: Always stash messages on session switch

**File:** `src/renderer/composables/useChat.ts`
**Lines:** 521-523

**Change:** In `loadSession()`, remove the `busySessions.value.has(oldSid)` condition. Always stash the current messages to `backgroundMessages` when switching away, regardless of busy state.

```js
// Before:
if (busySessions.value.has(oldSid)) {
  backgroundMessages.set(oldSid, messages.value.map(m => ({ ...m })))
}

// After:
if (messages.value.length > 0) {
  backgroundMessages.set(oldSid, messages.value.map(m => ({ ...m })))
}
```

This ensures messages are never silently dropped. The background buffer is cleaned up when `loadSession` consumes it (line 534), so there's no memory leak concern.

**Risk:** Low. The only downside is keeping a shallow copy of messages in memory for idle sessions, which is negligible.

### Fix 2: Read from background buffer first in persistMessagesFor

**File:** `src/renderer/composables/useChat.ts`
**Lines:** 472-476

**Change:** Fix `persistMessagesFor` to always check `backgroundMessages` first, only falling back to `messages.value` if the sessionId matches the current session *and* no background buffer exists. This eliminates the window where `currentSessionId` changes between scheduling and persisting.

```js
// Before:
const msgs = sessionId === currentSessionId.value
  ? messages.value
  : backgroundMessages.get(sessionId)

// After:
const msgs = backgroundMessages.get(sessionId)
  ?? (sessionId === currentSessionId.value ? messages.value : undefined)
```

This is safe because `backgroundMessages` is never populated for the current session during normal operation — `loadSession` deletes the buffer when consuming it (line 534), and `handleChunk` routes current-session chunks to `messages.value`.

Apply the same fix to `startStreamingStash` (line 222-225) for consistency:

```js
// In startStreamingStash's interval callback:
const msgs = backgroundMessages.get(sessionId)
  ?? (sessionId === currentSessionId.value ? messages.value : undefined)
```

**Risk:** Low. This only changes lookup order, not behavior, for the normal case. It adds resilience for the race case.

### Fix 3: Relax the saveMessages guard

**File:** `src/daemon/sessions.ts`
**Lines:** 148-155

**Change:** The current guard blocks saves when message count drops by more than 5. This is too aggressive for normal streaming behavior where thinking messages are created and removed. Options:

**Option A — Percentage-based threshold (recommended):**

```js
const loss = existing.count - messages.length
const threshold = Math.max(10, Math.floor(existing.count * 0.5))
if (loss > threshold) {
  console.warn(`[bond] saveMessages blocked: would lose ${loss} messages (${messages.length} < ${existing.count}) for session ${sessionId}`)
  return false
}
```

This allows normal churn (thinking messages removed, tools collapsed) while still catching catastrophic data loss (crash sends empty array). For a 20-message conversation, allows dropping up to 10. For a 100-message conversation, allows dropping up to 50.

**Option B — Only guard against empty/near-empty saves (simpler):**

```js
if (messages.length === 0) {
  console.warn(`[bond] saveMessages blocked: refusing empty save for session ${sessionId} (${existing.count} existing)`)
  return false
}
```

This is the most permissive while still preventing the crash scenario (renderer sends `[]`). The real protection against data loss is Fix 1 + Fix 2, not this guard.

Recommend **Option B** as the immediate fix. The guard was a safety net for a specific scenario (crash sends empty array). With the other fixes in place, it doesn't need to be clever.

### Fix 4: Serialize loadSession calls to prevent overlap

**File:** `src/renderer/composables/useChat.ts`
**Lines:** ~515

**Change:** Add a simple lock to prevent overlapping `loadSession` calls. If a load is in progress, queue the next one and discard the current load's work when the newer one starts.

```js
let _loadSessionLock: Promise<void> | null = null
let _pendingLoadSessionId: string | null = null

async function loadSession(sessionId: string) {
  // If another loadSession is in flight, just record what we actually want
  // and let the in-flight call handle it when it finishes.
  if (_loadSessionLock) {
    _pendingLoadSessionId = sessionId
    await _loadSessionLock
    // If something newer came in while we waited, bail — that one will run
    if (_pendingLoadSessionId !== sessionId) return
  }

  let resolve!: () => void
  _loadSessionLock = new Promise(r => { resolve = r })
  _pendingLoadSessionId = null

  try {
    await _loadSessionCore(sessionId)
  } finally {
    _loadSessionLock = null
    resolve()

    // If a newer session was requested while we ran, load it now
    if (_pendingLoadSessionId) {
      const next = _pendingLoadSessionId
      _pendingLoadSessionId = null
      loadSession(next)
    }
  }
}
```

Move the current `loadSession` body into `_loadSessionCore`. This ensures only one load runs at a time, and rapid clicks (A → B → C) collapse into loading A (already started) then C (latest request), skipping B.

**Risk:** Low. Adds a few ms of serialization latency that's invisible to the user. The pattern is well-understood (debounce/gate).

### Fix 5: Wire up subscribe/unsubscribe on session switch

**File:** `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/composables/useChat.ts`

**Change:** When the renderer loads a session, call `subscribe(sessionId)` on the daemon via the IPC bridge. When switching away, call `unsubscribe(oldSessionId)` — unless that session is still busy.

**Step 1 — Expose in preload:**
```js
subscribe: (sessionId: string) => ipcRenderer.invoke('bond:subscribe', sessionId),
unsubscribe: (sessionId: string) => ipcRenderer.invoke('bond:unsubscribe', sessionId),
```

**Step 2 — Handle in main process:** Forward `bond:subscribe` and `bond:unsubscribe` to the daemon's `BondClient` methods (already exist).

**Step 3 — Call from loadSession:**
```js
// In loadSession, after setting currentSessionId:
deps.subscribe?.(sessionId)

// When switching away (before the stash):
if (oldSid && !busySessions.value.has(oldSid)) {
  deps.unsubscribe?.(oldSid)
}
```

Don't unsubscribe from busy sessions — we still need their chunks for background buffering.

**Risk:** Low. This is additive — the daemon already handles both RPCs. The renderer just isn't calling them.

### Fix 6: Clean up stale localStorage backups

**File:** `src/renderer/composables/useChat.ts`

**Change:** After a successful `loadSession` from DB (line 557-573), clean up the localStorage backup for that session:

```js
// After messages.value = msgs at line 573:
try { localStorage.removeItem(`bond:msg-backup:${sessionId}`) } catch {}
```

Currently, stale backups accumulate in localStorage. On reconnection, `restoreFromBackupIfNeeded` might apply an outdated backup over correct DB data if the text-length heuristic misjudges. Cleaning up after successful loads prevents this.

**Risk:** Minimal. Worst case: we lose a backup that would have been useful after a future crash. But the streaming stash timer recreates it within 15s if the session is active.

---

## Implementation Order

1. **Fix 1** — Always stash (5 min, highest impact, zero risk)
2. **Fix 2** — Background-buffer-first persist (5 min, medium impact, low risk)
3. **Fix 3** — Relax saveMessages guard (5 min, medium impact, low risk)
4. **Fix 4** — Serialize loadSession (15 min, prevents overlap race, low risk)
5. **Fix 6** — Clean up stale backups (2 min, hygiene)
6. **Fix 5** — Wire up subscriptions (30 min, low impact, good architecture hygiene)

Fixes 1–4 should ship together — they address the same bug from different angles. Fix 5 is independent. Fix 6 is trivial and can go with either batch.

## Testing

### Unit tests to add (`useChat.test.ts`)

Each fix should have a targeted regression test:

**Fix 1 — Always stash:**
- `loadSession stashes messages even when session is not busy` — submit, let query_end fire, immediately loadSession to B, loadSession back to A → messages present
- `loadSession stashes empty-messages session as empty array` — verify no crash when stashing session with 0 messages

**Fix 2 — Background-buffer-first persist:**
- `persistMessagesFor reads from backgroundMessages after session switch` — submit in A, switch to B, trigger persist for A → verify save called with A's messages (not B's)

**Fix 3 — Guard relaxation:**
- Test in `sessions.test.ts` or daemon tests: `saveMessages allows removing up to N messages` and `saveMessages blocks empty save`

**Fix 4 — Serialized loadSession:**
- `rapid A→B→C loadSession settles on C` — fire three loadSession calls without awaiting, verify final state is C's messages and B's messages were never loaded
- `overlapping loadSession preserves stash for intermediate session` — A→B→C, verify A's messages are stashed

### Manual QA (reproduce the original bug)

1. Start a chat, send a long prompt that triggers tool use (takes 30+ seconds)
2. Mid-stream, switch to a new session and send a message
3. Wait for the second session to finish responding
4. Switch back to the first session — **verify all messages are present**
5. Repeat with the first session finishing while you're in the second session

### Edge cases to verify

- Switch sessions rapidly (A → B → A → B) while both are streaming
- Switch away right as `query_end` fires (hardest to hit manually, consider adding a small artificial delay in dev)
- Verify the `saveMessages` guard doesn't block legitimate saves (check daemon logs for the warning)
- Kill the renderer process mid-stream, relaunch, verify localStorage backup restores correctly
- Triple-rapid-click: A → B → C while A is streaming — verify A's messages are stashed and C loads correctly
- Submit a message with images, switch away mid-stream, switch back — verify images are still attached
- Queue a message (submit twice), switch away, first query completes in background, switch back — verify queued message is still pending
