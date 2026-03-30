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
    BondText.vue                 # Polymorphic text primitive (any element, size, weight, color)
    BondButton.vue               # Button primitive (primary/secondary/ghost/danger)
    BondInput.vue                # Text input primitive with v-model
    BondTextarea.vue             # Multi-line textarea primitive with v-model
    BondSelect.vue               # Dropdown select primitive
    BondTab.vue                  # Segmented tab bar primitive
    BondPanelGroup.vue           # Resizable panel container (horizontal/vertical)
    BondPanel.vue                # Individual resizable panel
    BondPanelHandle.vue          # Drag handle between panels
    panelTypes.ts                # Shared types and injection key for panel system
    ChatHeader.vue               # Chat title display
    ChatInput.vue                # Textarea + stop/send buttons
    MessageBubble.vue            # Renders all message variants
    ThinkingIndicator.vue        # Animated working indicator
    MarkdownMessage.vue          # Markdown rendering with syntax highlighting
    SessionItem.vue              # Single session row (used in sidebar lists)
    SessionSidebar.vue           # Sidebar with session list and controls
    DevComponents.vue            # Dev screen — component catalog
  lib/highlight.ts               # highlight.js language registration
```

## Components

**Always use existing components** before creating new ones. When you add a new component or change props/events on an existing one, update this section AND the `DevComponents.vue` catalog.

### BondText
Polymorphic text component for all UI text. Renders any HTML element via `as` prop.
- **Props:** `as?: string` (default: `'span'`), `size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl'`, `weight?: 'normal' | 'medium' | 'semibold' | 'bold'`, `color?: 'primary' | 'muted' | 'accent' | 'err' | 'ok' | 'inherit'`, `align?: 'left' | 'center' | 'right'`, `truncate?: boolean`, `mono?: boolean`
- **Slot:** default — text content

### BondButton
Button with variant and size options.
- **Props:** `variant?: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size?: 'sm' | 'md'`, `disabled?: boolean`
- **Slot:** default — button label

### BondInput
Text input with v-model support.
- **Props:** `modelValue?: string`, `placeholder?: string`, `type?: string`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondTextarea
Multi-line textarea with v-model support.
- **Props:** `modelValue?: string`, `placeholder?: string`, `rows?: number`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondSelect
Dropdown select with custom chevron.
- **Props:** `modelValue?: string`, `options: { value, label }[]`, `disabled?: boolean`
- **Events:** `update:modelValue(value: string)`

### BondTab
Segmented tab bar.
- **Props:** `tabs: { id, label }[]`, `modelValue?: string`
- **Events:** `update:modelValue(value: string)`

### BondPanelGroup
Flex container that manages resizable panel layout. Nest `BondPanel` and `BondPanelHandle` as direct children.
- **Props:** `direction?: 'horizontal' | 'vertical'`, `autoSaveId?: string` (localStorage key), `keyboardStep?: number` (default: 5)
- **Events:** `layoutChange(layout)` (during drag), `layoutChanged(layout)` (after drag ends)
- **Expose:** `getLayout()`, `setLayout(layout)`

### BondPanel
Individual resizable panel. Must be a direct child of `BondPanelGroup`. Slot props: `{ size, collapsed }`.
- **Props:** `id: string`, `defaultSize?: number` (%), `minSize?: number` (% default: 10), `maxSize?: number` (% default: 100), `collapsible?: boolean`, `collapsedSize?: number` (% default: 0), `header?: string` (renders a section header with collapse/expand chevron when collapsible)
- **Slots:** `default` (panel content), `header-extra` (extra controls in the header row, e.g. a + button)
- **Expose:** `collapse()`, `expand()`, `getSize()`, `isCollapsed()`, `resize(size)`

### BondPanelHandle
Drag handle placed between panels. Supports pointer drag, keyboard arrows, Home/End. Styled via `data-state` attribute (`inactive` | `hover` | `drag`).
- **Props:** `id: string` (format: `handle-N`), `disabled?: boolean`, `hitArea?: number` (px, default: 8)
- **Accessibility:** `role="separator"`, arrow keys, `aria-orientation`

### ChatHeader
Displays the current chat title. Rendered inside the app-header layout shell in App.vue.
- **Props:** `title: string`

### ChatInput
Unified chat box combining textarea, model selector, attach button, and a single contextual action button. Auto-focuses after response completes.
- **Props:** `busy: boolean` — swaps action button between send/stop, `model: ModelId`
- **Events:** `submit(text: string, images: AttachedImage[])`, `cancel()`, `update:model(value: ModelId)`
- Single bordered container with textarea on top and a toolbar row below (model select, attach, action button). Action button shows send (arrow-up, accent) when idle, stop (stop icon) when busy. Attach button opens native file picker for jpeg/png/gif/webp. Image thumbnails appear above textarea inside the box.

### MessageBubble
Renders all message variants based on the `Message` union type. Delegates markdown to MarkdownMessage. User messages render attached images above text.
- **Props:** `msg: Message` — role/kind determines which variant renders

### MarkdownMessage
Renders markdown with syntax highlighting and copy-to-clipboard code blocks.
- **Props:** `text: string`, `streaming: boolean`

### ThinkingIndicator
Animated "Bond is working..." with blinking dots. No props or events.

### SessionItem
Single session row used in both active and archived lists inside SessionSidebar. Action button floats over content on hover (no reserved space).
- **Props:** `session: Session`, `active?: boolean`, `archived?: boolean`, `generating?: boolean`, `actionTitle: string`
- **Slot:** default — action button content (icon)
- **Events:** `select()`, `action()`

### SessionSidebar
Left sidebar with session lists and nav links. Uses SessionItem for consistent rendering across active and archived lists. Archives section has built-in collapse/expand.
- **Props:** `sessions: Session[]`, `archivedSessions: Session[]`, `activeSessionId: string | null`, `activeView: AppView`, `generatingTitleId: string | null`
- **Events:** `select(id)`, `create()`, `archive(id)`, `unarchive(id)`, `remove(id)`, `switchView(view)`

### DevComponents
Dev-only component catalog. Toggle with **Cmd+Shift+D**. Not rendered in production flows.

## Icons

Bond uses [Phosphor Icons](https://phosphoricons.com) via `@phosphor-icons/vue`. Import individual icons by name — they are tree-shaken automatically.

```vue
<script lang="ts" setup>
import { PhHouse, PhGear, PhTrash } from '@phosphor-icons/vue'
</script>

<template>
  <PhHouse :size="20" weight="regular" />
  <PhGear :size="20" weight="bold" />
  <PhTrash :size="20" color="var(--color-err)" />
</template>
```

### Props (all optional)
- **size**: `number | string` — width & height (default: `24`)
- **color**: `string` — stroke/fill color, any CSS value (default: `currentColor`)
- **weight**: `"thin" | "light" | "regular" | "bold" | "fill" | "duotone"` (default: `"regular"`)
- **mirrored**: `boolean` — flip horizontally for RTL

### Rules
- **Always use `currentColor`** (the default) so icons inherit text color from their parent.
- **Import individually** — never register globally, to keep bundles small.
- Browse available icons at [phosphoricons.com](https://phosphoricons.com).

## Design Tokens

Colors are defined in `app.css` via Tailwind v4's `@theme` directive. Dark mode uses `prefers-color-scheme` media query. Use the existing token names (`bg`, `surface`, `border`, `text-primary`, `muted`, `accent`, `err`, `ok`) in Tailwind classes.
