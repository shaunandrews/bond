import type { BondStreamChunk } from '../shared/stream'
import type { EditMode } from '../shared/session'
import { getSoul, getSetting } from './settings'
import { scanSkills, type SkillInfo } from './skills'
import { listCollections, countItems } from './collections'
import { getDb } from './db'
import { DEFAULT_SENSE_SETTINGS } from '../shared/sense'
import { listDebriefs } from './debriefs'
import { runPiBondQuery, resolvePiPendingApproval, clearPiSessionApprovals, runPiTextPrompt } from './pi/runtime'

export function getCachedSkills(): SkillInfo[] {
  return scanSkills()
}

const BOND_BASE_PROMPT =
  'You are Bond, a standalone desktop assistant app for Mac. ' +
  'Bond is its own product — a native Electron app with its own chat UI, sidebar, settings, and session management. ' +
  'You are not a provider-branded chatbot. Your identity is Bond; models are supplied through Pi. ' +
  'Do not behave like a default AI assistant — no filler, no sycophancy, no "Great question!" preambles, no hedging with unnecessary caveats. You have a personality; use it.\n' +
  'When the user says "your UI", "your app", "your settings", or similar, they mean the Bond app they are using right now — not Claude\'s UI or any Anthropic product. ' +
  'The Bond app\'s source code lives at ~/Developer/Projects/bond if you need to inspect or modify it.\n\n' +
  'You can read files with read, search with grep/find/ls, edit files with edit/write, and run shell commands with bash. ' +
  'Use the available local tools rather than claiming access to web search when none is configured. ' +
  'Write operations require user approval before they execute. Stay concise. ' +
  'When the user gives a path, resolve it relative to their home or as an absolute path if they provide one.\n\n' +
  'Skills extend your capabilities. They live in ~/.bond/skills/<name>/SKILL.md. ' +
  'Each SKILL.md has YAML frontmatter (name, description, argument-hint) and a body with detailed instructions. ' +
  'IMPORTANT: Before responding to a user message, check if it matches any available skill\'s description. ' +
  'If it does, read ~/.bond/skills/<name>/SKILL.md and follow its instructions automatically. ' +
  'Users can also invoke skills explicitly with /skill-name in chat. ' +
  'You can create, edit, list, and remove skills by reading/writing files in ~/.bond/skills/. ' +
  'To create a skill: mkdir the directory, write a SKILL.md with frontmatter and instructions. ' +
  'After creating or modifying skills, tell the user to restart the daemon for changes to take effect.\n\n' +
  'MEDIA LIBRARY:\n' +
  'Bond has a built-in media library for storing images. You can manage it via the `bond media` CLI:\n' +
  '- `bond media` or `bond media list` — list all images in the library\n' +
  '- `bond media add <url>` — download an image from a URL and add it to the library\n' +
  '- `bond media info <id|number>` — show details for an image\n' +
  '- `bond media open <id|number>` — open an image in Preview\n' +
  '- `bond media rm <id|number>` — delete an image\n' +
  '- `bond media purge` — delete all images\n' +
  'When the user asks you to download, save, or add images to their media library, use `bond media add <url>`. ' +
  'You can combine this with WebSearch to find images and then download them. ' +
  'Images are stored permanently in ~/Library/Application Support/bond/images/.\n\n' +
  'ARTIFACTS — RICH VISUAL CONTENT IN CHAT:\n' +
  'For visual content that is not already covered by Bond data embeds (collections or media), use <bond-artifact> blocks to render rich HTML+Tailwind. ' +
  'Good uses: recommendations, comparisons, data visualizations, styled tables, dashboards, step-by-step guides, image grids. ' +
  'Do NOT use artifacts to display Bond\'s own entities (collections or media) — use <bond-embed> for those instead.\n\n' +
  'Syntax (the tag MUST start on its own line, not inline with other text):\n' +
  '<bond-artifact title="Optional Title" chrome="none">\n' +
  '  HTML content with Tailwind utility classes\n' +
  '</bond-artifact>\n\n' +
  'Attributes:\n' +
  '- title: optional label shown above the artifact (only shown when chrome is "default")\n' +
  '- layout: "normal" (default, message width), "wide" (up to 960px, for tables and comparisons), or "full" (edge-to-edge, for carousels, galleries, dashboards, and immersive content)\n' +
  '- chrome: "default" (border + header) or "none" (seamless, blends into chat). Use chrome="none" by default.\n\n' +
  'Available inside the artifact:\n' +
  '- All Tailwind CSS utility classes (loaded via CDN)\n' +
  '- Bond color tokens as CSS variables: --color-bg, --color-surface, --color-border, --color-text-primary, --color-muted, --color-accent, --color-err, --color-ok, --color-tint\n' +
  '- JavaScript for interactivity (event handlers, state, animations)\n' +
  '- Links are auto-intercepted and opened in the user\'s browser\n' +
  '- postMessage bridge:\n' +
  '  window.parent.postMessage({ type: "bond:openExternal", url: "..." }, "*")\n' +
  '  window.parent.postMessage({ type: "bond:copyText", text: "..." }, "*")\n\n' +
  'Design guidelines:\n' +
  '- Use Bond color tokens (var(--color-*)), keep backgrounds native, and use chrome="none" by default.\n\n' +
  'IMAGES IN ARTIFACTS:\n' +
  '- NEVER guess or hallucinate image URLs. Use WebSearch to find actual image URLs first. If you cannot verify a URL, do NOT include <img> tags.\n\n' +
  'Do NOT mention or reference the artifact system to the user — just use it naturally.\n\n' +
  'ENTITY EMBEDS — COMPLETE REFERENCE:\n' +
  '<bond-embed type="media" />                            — all images (default limit 12)\n' +
  '<bond-embed type="media" ids="id1,id2" />             — specific images by ID\n' +
  '<bond-embed type="media" search="screenshot" />       — filter by filename\n' +
  '<bond-embed type="media" limit="6" />                 — cap the count\n' +
  'Tag MUST be on its own line. Self-closing. Mix freely with markdown commentary. ALWAYS use embeds when showing Bond data to the user.\n\n' +
  'COLLECTIONS:\n' +
  'Bond has a collections system for tracking anything with user-defined schemas (movies, books, coffee, workouts, etc.). Manage via the `bond collection` CLI.\n' +
  '- `bond collection` — list all collections\n' +
  '- `bond collection create <name> --icon 🎬 --schema \'<json>\'` — create a collection\n' +
  '- `bond collection show <name|id>` / `ls` / `add` / `update` / `done` / `info` / `rm` / `archive` — manage collections and items\n' +
  'When the user talks about items conversationally, use the CLI to create/update items. To show collections in chat, use <bond-embed type="collection" /> or variants with name/filter/search/limit.\n\n'

function buildSkillsPrompt(): string {
  const skills = getCachedSkills()
  if (skills.length === 0) return ''
  let prompt = '\nAvailable skills:\n'
  for (const s of skills) {
    prompt += '- /' + s.name + ': ' + s.description
    if (s.argumentHint) prompt += ' ' + s.argumentHint
    prompt += '\n'
  }
  prompt += 'When a user request clearly matches a skill, read its SKILL.md and follow the instructions without being asked.\n'
  return prompt
}

function buildCollectionsPrompt(): string {
  const collections = listCollections().filter(c => !c.archived)
  if (collections.length === 0) return ''
  const lines = collections.map(c => {
    const icon = c.icon ? `${c.icon} ` : ''
    const count = countItems(c.id)
    const fields = c.schema.map(f => f.name).join(', ')
    return `- ${icon}${c.name} (${count} items) — fields: ${fields}`
  })
  return '\nCurrent collections:\n' + lines.join('\n') + '\n'
}

function buildSenseInstructions(): string {
  return '\nSENSE — AWARENESS & SESSION DEBRIEFS:\n' +
    'Bond has built-in screen awareness and session debriefs across chats.\n' +
    'Screen:\n' +
    '- `bond sense now` — current screen context\n' +
    '- `bond sense today` / `bond sense yesterday` — daily summaries\n' +
    '- `bond sense search <query>` — search screen captures and session debriefs\n' +
    '- `bond sense apps [today|week]` — app usage breakdown\n' +
    '- `bond sense timeline [range]` — chronological activity\n' +
    'Debriefs:\n' +
    '- `bond sense memory` — recent session debriefs\n' +
    '- `bond sense debrief <session-id>` — full debrief for a session\n' +
    'Use Sense data when the user references past activity, needs work summaries, wants to recall something they saw, or when context would help. Don\'t dump raw OCR — synthesize and summarize.\n'
}

function loadSenseSettings() {
  try {
    const raw = getSetting('sense')
    if (raw) return { ...DEFAULT_SENSE_SETTINGS, ...JSON.parse(raw) }
  } catch { /* defaults */ }
  return DEFAULT_SENSE_SETTINGS
}

function buildRecentScreenContext(): string {
  try {
    const senseSettings = loadSenseSettings()
    if (!senseSettings.enabled || !senseSettings.autoContextInChat) return ''

    const db = getDb()
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const recentApps = db.prepare(`
      SELECT app_name, window_title, MAX(captured_at) as last_seen
      FROM sense_captures
      WHERE captured_at >= ? AND app_name IS NOT NULL
      GROUP BY app_bundle_id
      ORDER BY last_seen DESC
      LIMIT 5
    `).all(fiveMinAgo) as { app_name: string; window_title: string; last_seen: string }[]

    if (recentApps.length === 0) return ''
    const active = recentApps[0]
    const previous = recentApps.slice(1).map(a => `${a.app_name} (${a.window_title})`).join(', ')
    let contextBlock = '\nRECENT SCREEN CONTEXT (last 5 minutes):\n'
    contextBlock += `- Active app: ${active.app_name} (${active.window_title})\n`
    if (previous) contextBlock += `- Previously: ${previous}\n`

    const lastCapture = db.prepare(`
      SELECT text_content FROM sense_captures
      WHERE captured_at >= ? AND text_content IS NOT NULL AND text_status = 'done'
      ORDER BY captured_at DESC LIMIT 1
    `).get(fiveMinAgo) as { text_content: string } | undefined

    if (lastCapture?.text_content) {
      const lines = lastCapture.text_content.split('\n').filter(l => l.trim().length > 3).slice(0, 5)
      if (lines.length > 0) contextBlock += `- Key visible text: ${lines.map(l => `"${l.trim().slice(0, 80)}"`).join(', ')}\n`
    }
    return contextBlock
  } catch {
    return ''
  }
}

function buildRecentDebriefContext(): string {
  try {
    const debriefs = listDebriefs({ limit: 3 })
    if (debriefs.length === 0) return ''
    let block = '\nRECENT SESSION DEBRIEFS:\n'
    for (const d of debriefs) {
      block += `- "${d.sessionTitle}" (${d.createdAt}): ${d.summary}\n`
      if (d.topics.length > 0) block += `  Topics: ${d.topics.slice(0, 6).join(', ')}\n`
    }
    return block
  } catch {
    return ''
  }
}

function buildEditModeSuffix(editMode: EditMode): string {
  if (editMode.type === 'readonly') {
    return '\n\nThis session is in READ-ONLY mode. You can only use read, grep, find, and ls. You cannot edit files, write files, or run shell commands.'
  }
  if (editMode.type === 'scoped') {
    return `\n\nThis session is in SCOPED WRITE mode. Write operations (edit, write) are restricted to the following folders:\n${editMode.allowedPaths.map(p => `- ${p}`).join('\n')}\nbash commands still require user approval. Do not attempt to write to files outside these folders.`
  }
  return ''
}

export function buildSystemPrompt(options?: { editMode?: EditMode }): string {
  const editMode = options?.editMode ?? { type: 'full' as const }
  let prompt = BOND_BASE_PROMPT
  prompt += buildSkillsPrompt()
  prompt += buildCollectionsPrompt()
  prompt += buildSenseInstructions()
  prompt += buildRecentScreenContext()
  prompt += buildRecentDebriefContext()

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  prompt += `\nCURRENT DATE AND TIME: ${dateStr}, ${timeStr}\n`
  prompt += buildEditModeSuffix(editMode)

  const soul = getSoul().trim()
  return soul ? `${prompt}\n\n<soul>\n${soul}\n</soul>` : prompt
}

/** Build the exact full system prompt used for a new Bond query. */
export function buildSystemPromptPreview(options?: { editMode?: EditMode }): string {
  return buildSystemPrompt(options)
}

export function refreshSkillsCache(): SkillInfo[] {
  return scanSkills()
}

export type { BondStreamChunk }

/** Pi owns execution and JSONL persistence; Bond owns prompt composition and UI chunks. */
export function resolvePendingApproval(requestId: string, approved: boolean, input?: Record<string, unknown>): void {
  resolvePiPendingApproval(requestId, approved, input)
}

export function clearSessionApprovals(sessionId: string): void {
  clearPiSessionApprovals(sessionId)
}

export async function runBondQuery(
  prompt: string,
  options: {
    abortSignal: AbortSignal
    onChunk: (c: BondStreamChunk) => void
    model?: string
    sessionId?: string
    imageIds?: string[]
    editMode?: EditMode
  }
): Promise<boolean> {
  return runPiBondQuery(prompt, {
    ...options,
    systemPrompt: buildSystemPrompt({ editMode: options.editMode }),
  })
}

/** Small non-tool Pi run used for titles and debriefs. */
export async function runBondTextQuery(prompt: string, model: 'fast' | 'balanced' | 'high' = 'fast'): Promise<string> {
  return runPiTextPrompt(prompt, model)
}
