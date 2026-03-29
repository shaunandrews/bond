# Bond — Claude Code Instructions

## Testing

Bond uses **Vitest** with **happy-dom** and **@vue/test-utils** for testing.

```bash
npm run test:run   # single run
npm test           # watch mode
```

Test files live next to their source: `useChat.ts` → `useChat.test.ts`, `ChatInput.vue` → `ChatInput.test.ts`.

### Rules

- **Always run `npm run test:run` after making changes** to verify nothing is broken.
- **Write tests for all new functionality.** New composables get unit tests. New components with logic or user interaction get component tests. Pure presentational components (no props, no events) can skip tests.
- **Composable tests** use a `withSetup` helper to run composables in a Vue app context. Inject mock `ChatDeps` instead of relying on `window.bond`.
- **Component tests** use `mount` or `shallowMount` from `@vue/test-utils`. Assert on emitted events, rendered text, and class presence — not computed styles (happy-dom doesn't process Tailwind).
- Test config is in `vitest.config.ts` (separate from `electron.vite.config.ts`).

## Project Structure

```
src/renderer/
  App.vue                        # Thin shell — wires composable to components
  app.css                        # Tailwind v4 theme tokens + prose styles
  types/message.ts               # Message union type
  composables/useChat.ts         # All chat state and logic
  components/
    ChatHeader.vue               # Header bar
    ChatInput.vue                # Textarea + stop/send buttons
    MessageBubble.vue            # Renders all message variants
    ThinkingIndicator.vue        # Animated working indicator
    MarkdownMessage.vue          # Markdown rendering with syntax highlighting
  lib/highlight.ts               # highlight.js language registration
```

## Design Tokens

Colors are defined in `app.css` via Tailwind v4's `@theme` directive. Dark mode uses `prefers-color-scheme` media query. Use the existing token names (`bg`, `surface`, `border`, `text-primary`, `muted`, `accent`, `err`, `ok`) in Tailwind classes.
