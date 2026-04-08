# Collections — Generic Entity Tracking System

A schema-flexible system for tracking *anything*: movies, TV shows, books, coffee, workouts, state parks, diet — whatever the user wants. Each collection defines its own fields, and items store structured data against that schema.

---

## Why

Bond already tracks todos and projects as first-class entities. But users want to track all kinds of things — watchlists, reading logs, tasting notes, fitness progress. Rather than building bespoke features for each, Collections provides a single generic system that the AI can create, populate, query, and display naturally through conversation.

---

## Data Model

### Two new tables

```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- "Movies", "Coffee", "State Parks"
  icon TEXT NOT NULL DEFAULT '',    -- emoji icon, e.g. "🎬"
  schema TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(schema)),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collection_items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_collection_items_collection ON collection_items(collection_id);
```

### Schema format

The `schema` column is a JSON array of field definitions:

```json
[
  { "name": "title",    "type": "text",    "primary": true },
  { "name": "year",     "type": "number" },
  { "name": "genre",    "type": "select",  "options": ["Action","Comedy","Drama","Horror","Sci-Fi","Thriller"] },
  { "name": "status",   "type": "select",  "options": ["Want to see","Watched","Abandoned"] },
  { "name": "rating",   "type": "rating",  "max": 5 },
  { "name": "review",   "type": "longtext" },
  { "name": "watchedOn","type": "date" }
]
```

### Field types

| Type          | Value stored        | Notes                                      |
|---------------|--------------------|--------------------------------------------|
| `text`        | string             | Short single-line text                     |
| `longtext`    | string             | Multi-line text (reviews, notes, etc.)     |
| `number`      | number             | Integer or float. Optional `prefix`/`suffix` for display (e.g. `"$"`, `"min"`, `"%"`) |
| `date`        | string             | ISO date `YYYY-MM-DD`                      |
| `boolean`     | boolean            | True/false toggle                          |
| `select`      | string             | One value from `options` array             |
| `multiselect` | string[]           | Multiple values from `options` array       |
| `rating`      | number             | 1 to `max` (default max: 5)               |
| `url`         | string             | Clickable link                             |
| `tags`        | string[]           | Free-form string array (no predefined options, unlike multiselect) |
| `image`       | string             | Image ID referencing the existing `images` table |

### Field definition shape

```ts
interface FieldDef {
  name: string        // key used in item data, e.g. "title", "rating"
  type: FieldType     // one of the types above
  primary?: boolean   // if true, this is the display title for the item (one per collection)
  options?: string[]  // for select/multiselect
  max?: number        // for rating (default 5)
  prefix?: string     // for number display (e.g. "$")
  suffix?: string     // for number display (e.g. "min", "%", "lbs")
  default?: any       // default value for new items (not back-filled to existing)
}
```

### Item data shape

Each item's `data` column is a flat JSON object keyed by field name:

```json
{
  "title": "Dune: Part Two",
  "year": 2024,
  "genre": "Sci-Fi",
  "status": "Watched",
  "rating": 5,
  "review": "Incredible sequel. Villeneuve at his best.",
  "watchedOn": "2026-04-01"
}
```

---

## Schema Evolution

Additive-only — the same strategy used by Notion, Airtable, and every successful schema-flexible system:

- **Adding a field:** Append to the schema array. Existing items return `null`/`undefined` for the new field. No migration needed.
- **Removing a field:** Remove from the schema array. Existing items retain the data in their JSON blobs, it just stops displaying. Safe and reversible.
- **Renaming a field:** Walk existing items and rename the JSON key synchronously. At personal-app scale (<1000 items), this is instant. Expose via `collection.renameField` RPC.
- **Changing a field type:** Not supported in v1. Create a new field, delete the old one.

---

## Implementation Plan

### Phase 1: Database + Daemon + Types

**Files to create/modify:**

1. **`src/shared/session.ts`** — Add TypeScript types (`Collection`, `CollectionItem`, `FieldDef`, `FieldType`)
2. **`src/daemon/db.ts`** — Add idempotent `migrateCreateCollectionsTable(db)` migration (check with `db.pragma('table_info(collections)')`)
3. **`src/daemon/collections.ts`** — New file, CRUD for collections and items
4. **`src/daemon/server.ts`** — Register RPC methods, add `broadcastCollectionsChanged()`

**RPC methods:**

| Method | Params | Returns |
|--------|--------|---------|
| `collection.list` | — | `Collection[]` |
| `collection.get` | `{ id }` | `Collection \| null` |
| `collection.create` | `{ name, icon?, schema }` | `Collection` |
| `collection.update` | `{ id, updates }` | `Collection \| null` |
| `collection.delete` | `{ id }` | `boolean` |
| `collection.archive` | `{ id }` | `Collection \| null` |
| `collection.unarchive` | `{ id }` | `Collection \| null` |
| `collection.renameField` | `{ id, oldName, newName }` | `boolean` |
| `collection.listItems` | `{ collectionId }` | `CollectionItem[]` |
| `collection.getItem` | `{ id }` | `CollectionItem \| null` |
| `collection.addItem` | `{ collectionId, data }` | `CollectionItem` |
| `collection.updateItem` | `{ id, data }` | `CollectionItem \| null` |
| `collection.deleteItem` | `{ id }` | `boolean` |
| `collection.reorderItems` | `{ ids }` | `boolean` |

**`collections.ts` structure** — Follows the exact pattern of `projects.ts`:

```ts
// Row types (CollectionRow, CollectionItemRow) matching DB columns
// COLLECTION_COLS, ITEM_COLS constants
// rowToCollection(), rowToItem() mappers (snake_case → camelCase, JSON parse for schema/data)
// CRUD: listCollections, getCollection, createCollection, updateCollection, deleteCollection
// archiveCollection, unarchiveCollection
// Items: listItems, getItem, addItem, updateItem, deleteItem, reorderItems
// renameField: walk items + update schema in a transaction
```

**Broadcast:** `broadcastCollectionsChanged()` notifies all connected clients via `makeNotification('collection.changed', {})`, same pattern as `broadcastTodoChanged()` and `broadcastProjectsChanged()`.

### Phase 2: IPC Bridge

**Files to modify:**

1. **`src/main/index.ts`** — Add `ipcMain.handle()` handlers for all collection RPC methods, wrapping `client.collection*()` calls
2. **`src/preload/index.ts`** — Expose via `contextBridge`:
   - `listCollections()`, `getCollection(id)`, `createCollection(...)`, `updateCollection(...)`, `deleteCollection(id)`
   - `archiveCollection(id)`, `unarchiveCollection(id)`
   - `listCollectionItems(collectionId)`, `addCollectionItem(...)`, `updateCollectionItem(...)`, `deleteCollectionItem(id)`, `reorderCollectionItems(ids)`
   - `onCollectionsChanged(fn)` — returns unsubscribe function

### Phase 3: CLI

**File:** `src/cli/collection.ts`

```
bond collection                                  List all collections
bond collection create <name>                    Create (interactive schema setup via flags)
bond collection create <name> --icon 🎬 --schema '<json>'
bond collection show <name|id>                   Show collection schema + item count
bond collection schema <name|id>                 Print schema as JSON
bond collection edit <name|id> --name <n>        Rename
bond collection edit <name|id> --icon <i>        Change icon
bond collection archive <name|id>                Archive
bond collection rm <name|id>                     Delete

bond collection ls <name|id>                     List all items
bond collection ls <name|id> --<field> <value>   Filter items by field value
bond collection add <name|id> --<field> <val>    Add an item
bond collection update <name|id> <item> --<field> <val>  Update item fields
bond collection done <name|id> <item>            (shortcut) If there's a status-like field, mark it "done"
bond collection rm <name|id> <item>              Delete an item
bond collection info <name|id> <item>            Show full item details
```

Item lookup (same pattern as todos): by ID prefix, 1-based numeric index, or primary field substring match.

Schema-aware flags: The CLI reads the collection's schema to know which `--<field>` flags are valid and how to parse their values (number, date, select validation, etc.).

### Phase 4: Agent Integration

**`src/daemon/agent.ts`** — Update the system prompt to include:
- Available collections and their schemas (so the AI knows what fields exist)
- Instructions for using `bond collection` CLI commands
- Natural language → structured data patterns (e.g. "just watched X, it was great" → update status + rating + date)

**System prompt additions:**

```
COLLECTIONS:
Bond has a collections system for tracking anything. You can manage it via `bond collection` CLI.
Current collections:
- 🎬 Movies (7 items) — fields: title, year, genre, status, rating, review, watchedOn
- ☕ Coffee (3 items) — fields: brand, origin, roast, method, rating, notes

When the user talks about items in a collection conversationally, use the CLI to create/update them.
Use <bond-embed type="collection" name="..." /> to show items in chat.
```

### Phase 5: Renderer — Composable + Embed

**New files:**

1. **`src/renderer/composables/useCollections.ts`** — Reactive wrapper around `window.bond` collection methods. Subscribes to `onCollectionsChanged()` for live updates. Follows `useProjects()` pattern:
   - **State:** `collections`, `activeCollectionId`, `activeCollection`, `activeCollections`, `archivedCollections`, `loading`
   - **Methods:** `load()`, `create(...)`, `select(id)`, `archive(id)`, `unarchive(id)`, `remove(id)`, `updateLocal(id, updates)`

2. **`src/renderer/components/embeds/CollectionEmbed.vue`** — Chat embed for displaying collections/items inline

**Embed syntax:**

```
<bond-embed type="collection" />                                  — all collections as cards
<bond-embed type="collection" name="Movies" />                    — items table for one collection
<bond-embed type="collection" name="Movies" filter="status=Want to see" />  — filtered
<bond-embed type="collection" name="Movies" ids="id1,id2" />     — specific items
<bond-embed type="collection" name="Movies" search="Dune" />     — text search across primary field
<bond-embed type="collection" name="Movies" limit="5" />         — cap results
```

**`EmbedRenderer.vue`** — Add `collection` to the `components` record with lazy `defineAsyncComponent` import.

### Phase 6: Renderer — Views + Navigation

**New files:**

1. **`src/renderer/components/CollectionsView.vue`** — Full-page view showing all collections as cards (icon + name + item count). Tap a collection to drill into items. Includes archive flyout, create wizard or inline creation. Uses `ViewShell` wrapper.
2. **`src/renderer/components/CollectionDetail.vue`** — Table view of items in a collection. Columns derived from schema. Add item button. Click-to-sort on column headers (type-aware: dates chronological, numbers numeric, text alphabetical, selects by option order). Group-by-select for status/category fields.

**Integration points:**

- **`useAppView.ts`** — Add `'collections'` to `AppView` union type
- **`SessionSidebar.vue`** — Add "Collections" nav item alongside Projects and Media, emitting a `collections()` event
- **`App.vue`** — Add `CollectionsView` import, handle sidebar `collections` event (`activeView = 'collections'`), add `v-show="activeView === 'collections'"` template block

**Right panel (optional, deferred):** Could add `CollectionPanelView.vue` as a right panel option (like `ProjectPanelView` / `TodoView`). Add `'collections'` to `RightPanelContent` union. Not needed for v1 — the full-page view is sufficient.

---

## Sorting & Filtering (v1 scope)

All sorting and filtering happens in JS after fetching items. Personal collections rarely exceed a few hundred items, so this is fine. SQLite `json_extract()` with generated columns is available as an escape hatch if performance becomes an issue later.

- **Sort:** Single-field sort with direction toggle. Click a column header. Type-aware comparison (dates chronological, numbers numeric, text case-insensitive, selects by option index, booleans false-first/true-first).
- **Filter:** Simple field-value matching. The AI handles complex queries conversationally. UI filter bar is a v2 nicety.
- **Group:** Group-by-select — show items sectioned by a select field's values (e.g. movies grouped by status). Single-level only. High usability impact for low effort.

---

## Example Schemas

### Movies
```json
[
  { "name": "title",     "type": "text",    "primary": true },
  { "name": "year",      "type": "number" },
  { "name": "genre",     "type": "select",  "options": ["Action","Comedy","Drama","Horror","Sci-Fi","Thriller","Romance","Documentary","Animation"] },
  { "name": "status",    "type": "select",  "options": ["Want to see","Watching","Watched","Abandoned"] },
  { "name": "rating",    "type": "rating",  "max": 5 },
  { "name": "review",    "type": "longtext" },
  { "name": "watchedOn", "type": "date" }
]
```

### TV Shows
```json
[
  { "name": "title",     "type": "text",    "primary": true },
  { "name": "season",    "type": "number" },
  { "name": "platform",  "type": "select",  "options": ["Netflix","HBO","Apple TV+","Disney+","Hulu","Prime","Other"] },
  { "name": "status",    "type": "select",  "options": ["Want to watch","Watching","Caught up","Finished","Dropped"] },
  { "name": "rating",    "type": "rating",  "max": 5 },
  { "name": "notes",     "type": "longtext" }
]
```

### Books
```json
[
  { "name": "title",      "type": "text",    "primary": true },
  { "name": "author",     "type": "text" },
  { "name": "genre",      "type": "select",  "options": ["Fiction","Non-fiction","Sci-Fi","Fantasy","Biography","Self-help","Technical"] },
  { "name": "status",     "type": "select",  "options": ["Want to read","Reading","Finished","Abandoned"] },
  { "name": "startedOn",  "type": "date" },
  { "name": "finishedOn", "type": "date" },
  { "name": "rating",     "type": "rating",  "max": 5 },
  { "name": "review",     "type": "longtext" }
]
```

### Coffee
```json
[
  { "name": "brand",   "type": "text",    "primary": true },
  { "name": "origin",  "type": "text" },
  { "name": "roast",   "type": "select",  "options": ["Light","Medium","Medium-Dark","Dark"] },
  { "name": "method",  "type": "select",  "options": ["Pour over","French press","Espresso","Aeropress","Cold brew","Drip"] },
  { "name": "rating",  "type": "rating",  "max": 5 },
  { "name": "notes",   "type": "longtext" }
]
```

### Workouts
```json
[
  { "name": "date",      "type": "date",    "primary": true },
  { "name": "type",      "type": "select",  "options": ["Strength","Cardio","HIIT","Yoga","Recovery","Other"] },
  { "name": "duration",  "type": "number",  "suffix": "min" },
  { "name": "exercises", "type": "longtext" },
  { "name": "notes",     "type": "longtext" }
]
```

### State Parks
```json
[
  { "name": "name",       "type": "text",    "primary": true },
  { "name": "state",      "type": "text" },
  { "name": "visited",    "type": "boolean" },
  { "name": "visitDate",  "type": "date" },
  { "name": "rating",     "type": "rating",  "max": 5 },
  { "name": "highlights", "type": "longtext" },
  { "name": "link",       "type": "url" }
]
```

---

## Build Order

1. **Types** — `session.ts`: `Collection`, `CollectionItem`, `FieldDef`, `FieldType`
2. **Database migration** — `db.ts`: idempotent `migrateCreateCollectionsTable()`
3. **Daemon CRUD** — `collections.ts`: full collection + item CRUD + `renameField`
4. **Server RPC** — `server.ts`: wire up all methods + `broadcastCollectionsChanged()`
5. **IPC bridge** — `main/index.ts` handlers + `preload/index.ts` bridge methods
6. **CLI** — `cli/collection.ts`: all subcommands
7. **Agent prompt** — `agent.ts`: expose collections + schemas to the AI
8. **Composable** — `useCollections.ts`: reactive state with change subscription
9. **Embed** — `CollectionEmbed.vue` + register in `EmbedRenderer.vue`
10. **Views** — `CollectionsView.vue` + `CollectionDetail.vue` + sidebar/routing integration

Steps 1–6 can be built and tested independently via CLI before any UI work.

---

## Files Changed (complete list)

| File | Action | Purpose |
|------|--------|---------|
| `src/shared/session.ts` | modify | Add `Collection`, `CollectionItem`, `FieldDef`, `FieldType` types |
| `src/daemon/db.ts` | modify | Add idempotent migration |
| `src/daemon/collections.ts` | **create** | Collection + item CRUD |
| `src/daemon/server.ts` | modify | Register RPC methods + broadcast |
| `src/main/index.ts` | modify | Add `ipcMain.handle()` wrappers |
| `src/preload/index.ts` | modify | Expose bridge methods + change listener |
| `src/cli/collection.ts` | **create** | CLI subcommands |
| `bin/bond` | modify | Add `collection` subcommand dispatch |
| `src/daemon/agent.ts` | modify | System prompt with collections + schemas |
| `src/renderer/composables/useCollections.ts` | **create** | Reactive state composable |
| `src/renderer/composables/useAppView.ts` | modify | Add `'collections'` to `AppView` union |
| `src/renderer/components/embeds/CollectionEmbed.vue` | **create** | Chat embed component |
| `src/renderer/components/EmbedRenderer.vue` | modify | Register `collection` embed |
| `src/renderer/components/CollectionsView.vue` | **create** | Full-page collections view |
| `src/renderer/components/CollectionDetail.vue` | **create** | Item table/detail view |
| `src/renderer/components/SessionSidebar.vue` | modify | Add Collections nav item |
| `src/renderer/App.vue` | modify | Import view, handle routing, add template |

---

## Not in v1

- **Changing field types** after items exist — create new field, delete old
- **Cross-collection relations** (item linking to item in another collection)
- **Formula / computed fields** — major complexity, a product unto itself
- **CSV/JSON import/export** — nice to have later
- **Right panel view** — full-page view is sufficient for v1
- **Multi-field cascade sort** — single-field sort is enough
- **UI filter bar** — the AI handles complex queries conversationally
- **Card/gallery/kanban views** — table view only for v1
