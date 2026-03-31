import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, normalize } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BondStreamChunk } from '../shared/stream'
import type { EditMode } from '../shared/session'
import { getSoul } from './settings'
import { getImagePaths } from './images'
import { getSkillsDir } from './paths'
import { scanSkills, type SkillInfo } from './skills'
import { listSites, getCachedSiteDetails } from './wordpress'

export function getCachedSkills(): SkillInfo[] {
  return scanSkills()
}

export function refreshSkillsCache(): SkillInfo[] {
  return scanSkills()
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash'])
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
const ALL_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash']

function extractTargetPath(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') return resolve(input.file_path)
  return null
}

function isWithinAllowedPaths(targetPath: string, allowedPaths: string[]): boolean {
  const target = normalize(targetPath)
  return allowedPaths.some(allowed => {
    const norm = normalize(resolve(allowed.replace(/^~/, homedir())))
    return target === norm || target.startsWith(norm + '/')
  })
}

type ApprovalResolve = (result: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void
const pendingApprovals = new Map<string, { resolve: ApprovalResolve; sessionId: string }>()

export function resolvePendingApproval(requestId: string, approved: boolean): void {
  const entry = pendingApprovals.get(requestId)
  if (!entry) return
  pendingApprovals.delete(requestId)
  entry.resolve(approved ? { behavior: 'allow' } : { behavior: 'deny', message: 'User denied this action' })
}

export function clearSessionApprovals(sessionId: string): void {
  for (const [id, entry] of pendingApprovals) {
    if (entry.sessionId === sessionId) {
      entry.resolve({ behavior: 'deny', message: 'Request cancelled' })
      pendingApprovals.delete(id)
    }
  }
}

export type { BondStreamChunk }

function summarizeToolInput(input: Record<string, unknown>): string | undefined {
  try {
    const path = input.file_path ?? input.path ?? input.pattern
    if (typeof path === 'string') return path
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return undefined
  }
}

function* flattenToolBlocks(msg: SDKMessage): Generator<BondStreamChunk> {
  if (msg.type !== 'assistant' || !msg.message?.content) return
  for (const block of msg.message.content) {
    if (block.type === 'tool_use' && 'name' in block) {
      const name = String(block.name)
      const input =
        'input' in block && block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {}
      yield { kind: 'assistant_tool', name, summary: summarizeToolInput(input) }
    }
  }
}

function extractStreamDelta(msg: SDKMessage): BondStreamChunk | null {
  if (msg.type !== 'stream_event') return null
  const evt = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } }
  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta' && evt.delta.text) {
      return { kind: 'assistant_text', text: evt.delta.text }
    }
    if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
      return { kind: 'thinking_text', text: evt.delta.thinking }
    }
  }
  return null
}

export function* bondMessageToChunks(message: SDKMessage): Generator<BondStreamChunk> {
  if (message.type === 'stream_event') {
    const delta = extractStreamDelta(message)
    if (delta) yield delta
    return
  }
  if (message.type === 'assistant') {
    // Text was already streamed via deltas — only emit tool blocks
    yield* flattenToolBlocks(message)
    return
  }
  if (message.type === 'result') {
    if (message.subtype === 'success') {
      yield {
        kind: 'result',
        subtype: message.subtype,
        result: message.result
      }
    } else {
      yield {
        kind: 'result',
        subtype: message.subtype,
        errors: message.errors
      }
    }
    return
  }
  if (message.type === 'auth_status') {
    yield {
      kind: 'auth_status',
      authenticating: message.isAuthenticating,
      lines: message.output ?? [],
      error: message.error
    }
    return
  }
  if (message.type === 'system' && message.subtype === 'api_retry') {
    yield {
      kind: 'system',
      subtype: 'api_retry',
      text: String(message.error ?? 'Retrying API request…')
    }
  }
}

export async function runBondQuery(
  prompt: string,
  options: {
    abortSignal: AbortSignal
    onChunk: (c: BondStreamChunk) => void
    model?: string
    sessionId?: string
    resumeSession?: boolean
    imageIds?: string[]
    editMode?: EditMode
    siteId?: string
  }
): Promise<boolean> {
  const cwd = homedir()
  const ac = new AbortController()

  // Resolve WordPress site context if session is scoped to a site
  let siteContext = ''
  if (options.siteId) {
    const { sites } = listSites()
    const site = sites.find(s => s.id === options.siteId)
    if (site) {
      // For screenshots, use the custom domain URL with the Studio port (e.g. http://my-site.wp.local:8882).
      // bond-screenshot handles custom domains automatically via a local proxy.
      // For sites without a custom domain, use localhost:port.
      const screenshotUrl = site.customDomain
        ? `http://${site.customDomain}:${site.port}`
        : `http://localhost:${site.port}`
      siteContext = `\n\nYou are working on WordPress site "${site.name}" at ${site.path}.\n` +
        `Site URL: ${site.url} | Status: ${site.running ? 'running' : 'stopped'} | Port: ${site.port}` +
        (site.customDomain ? ` | Custom domain: ${site.customDomain}` : '') + '\n' +
        `Use --path ${site.path} for all studio/wp commands.\n` +
        `Use --url ${screenshotUrl} for bond-validate-blocks and bond-screenshot.`

      // Append cached WP-CLI details if available (avoids the agent needing to run WP-CLI discovery commands)
      if (site.running) {
        const details = getCachedSiteDetails(site.path)
        if (details) {
          const activeTheme = details.themes.find(t => t.status === 'active')
          const activePlugins = details.plugins.filter(p => p.status === 'active').map(p => p.name)
          siteContext += `\n\nSite details (cached, no need to re-fetch):\n` +
            `WordPress ${details.wpVersion} | PHP ${site.phpVersion}\n` +
            (details.siteTitle ? `Title: ${details.siteTitle}` + (details.tagline ? ` — ${details.tagline}` : '') + '\n' : '') +
            (activeTheme ? `Active theme: ${activeTheme.name} (${activeTheme.version})\n` : '') +
            (activePlugins.length ? `Active plugins: ${activePlugins.join(', ')}\n` : '') +
            `Content: ${details.postCount} posts, ${details.pageCount} pages, ${details.userCount} users\n` +
            (details.permalinkStructure ? `Permalinks: ${details.permalinkStructure}\n` : '') +
            `Templates: ${details.templates.map(t => t.title || t.name).join(', ')}`

          // Inject actual page/post content so the agent understands what the site is about
          if (details.content.length > 0) {
            siteContext += '\n\nPublished content (you already have this — do NOT re-fetch with WP-CLI):'
            for (const item of details.content) {
              // Strip block delimiter comments for readability
              const cleaned = item.content
                .replace(/<!-- \/?wp:[^\s]+(?: \{[^}]*\})? -->/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
              siteContext += `\n\n--- ${item.type.toUpperCase()}: "${item.title}" (/${item.slug}) ---\n${cleaned}`
            }
          }

          // Redesign guidance — helps the agent ask smart questions instead of generic discovery
          siteContext += '\n\n' +
            'REDESIGN GUIDANCE (for when the user asks to redesign, restyle, or improve this site):\n' +
            '- You already have the site\'s content above. Read it to understand what the site is about, who it\'s for, and what it does.\n' +
            '- Do NOT ask the user basic questions you can answer from the content (e.g. "What is this site about?" or "Is this a band?").\n' +
            '- Take a screenshot to see the current visual state.\n' +
            '- Then ask 2-3 pointed design questions based on what you know: aesthetic direction, what\'s not working about the current design, specific goals (more bookings? sell merch? look more professional?). Frame questions around the content you\'ve already read.\n' +
            '- Follow the design guidelines in the /wordpress skill for implementation.'
        }
      }
    }
  }

  const basePrompt =
    'You are Bond, a standalone desktop assistant app for Mac. ' +
    'Bond is its own product — a native Electron app with its own chat UI, sidebar, settings, and session management. ' +
    'You are NOT Claude, Claude Code, or the Claude website. You are powered by Claude (an AI model by Anthropic), but your identity is Bond. ' +
    'When the user says "your UI", "your app", "your settings", or similar, they mean the Bond app they are using right now — not Claude\'s UI or any Anthropic product. ' +
    'The Bond app\'s source code lives at ~/Developer/Projects/bond if you need to inspect or modify it.\n\n' +
    'You can read files with Read, search with Glob and Grep, edit files with Edit and Write, and run shell commands with Bash. ' +
    'You can search the web with WebSearch and fetch page content with WebFetch. ' +
    'Write operations require user approval before they execute. Stay concise. ' +
    'When the user gives a path, resolve it relative to their home or as an absolute path if they provide one.\n\n' +
    'Skills extend your capabilities. They live in ~/.bond/skills/<name>/SKILL.md. ' +
    'Each SKILL.md has YAML frontmatter (name, description, argument-hint) and a body with instructions. ' +
    'You can create, edit, list, and remove skills by reading/writing files in ~/.bond/skills/. ' +
    'To create a skill: mkdir the directory, write a SKILL.md with frontmatter and instructions. ' +
    'The user invokes skills by typing /skill-name in chat. After creating or modifying skills, tell the user to restart the daemon for changes to take effect.\n\n' +
    'You are an expert with WordPress and the `studio` CLI (WordPress Studio).\n\n' +
    'STUDIO CLI REFERENCE:\n' +
    'All sites live in ~/Studio/. Always pass --path to target a site.\n\n' +
    'Site management:\n' +
    '  studio site list --format json          # Returns [{id, name, path, port, url, running}, ...]\n' +
    '  studio site create --name "Name" --path ~/Studio/slug --start true --skip-browser true\n' +
    '  studio site start --path PATH\n' +
    '  studio site stop --path PATH\n' +
    '  studio site status --path PATH          # URL, PHP/WP version, admin creds\n' +
    '  studio site delete --path PATH\n' +
    '  studio site set --path PATH --php 8.4   # Also: --domain, --https, --wp, --xdebug, --admin-username, --admin-password\n\n' +
    'WP-CLI (via studio wp <command> --path PATH):\n' +
    '  IMPORTANT: Site must be running before WP-CLI commands work. Start it first if needed.\n\n' +
    '  Content:\n' +
    '    studio wp post list --post_type=post --fields=ID,post_title,post_status --path PATH\n' +
    '    studio wp post create --post_type=post --post_title="Title" --post_content="<p>HTML</p>" --post_status=publish --path PATH\n' +
    '    studio wp post update POST_ID --post_title="New" --path PATH\n' +
    '    studio wp post get POST_ID --field=post_content --path PATH\n' +
    '    studio wp post delete POST_ID --path PATH\n' +
    '    studio wp post meta get/update POST_ID key [value] --path PATH\n\n' +
    '  Plugins:\n' +
    '    studio wp plugin list --path PATH\n' +
    '    studio wp plugin install SLUG --activate --path PATH\n' +
    '    studio wp plugin activate/deactivate SLUG --path PATH\n' +
    '    studio wp plugin update SLUG --path PATH\n' +
    '    studio wp plugin delete SLUG --path PATH\n' +
    '    studio wp plugin search "term" --fields=name,slug,rating --path PATH\n\n' +
    '  Themes:\n' +
    '    studio wp theme list --path PATH\n' +
    '    studio wp theme install SLUG --activate --path PATH\n' +
    '    studio wp theme activate SLUG --path PATH\n' +
    '    studio wp theme search "term" --fields=name,slug,rating --path PATH\n\n' +
    '  Options:\n' +
    '    studio wp option get OPTION --path PATH\n' +
    '    studio wp option update OPTION "value" --path PATH\n' +
    '    Common: blogname, blogdescription, siteurl, home, permalink_structure\n\n' +
    '  Users:\n' +
    '    studio wp user list --fields=ID,user_login,user_email,roles --path PATH\n' +
    '    studio wp user create USERNAME EMAIL --role=editor --path PATH\n\n' +
    '  Database:\n' +
    '    studio wp db export ~/Desktop/backup.sql --path PATH\n' +
    '    studio wp db import file.sql --path PATH\n' +
    '    studio wp search-replace "old" "new" --path PATH\n\n' +
    '  Menus:\n' +
    '    studio wp menu list/create --path PATH\n' +
    '    studio wp menu item add-post MENU_ID POST_ID --path PATH\n' +
    '    studio wp menu item add-custom MENU_ID "Label" "url" --path PATH\n\n' +
    '  Other: wp core version/update, wp transient delete --all, wp cache flush, wp scaffold block\n\n' +
    'Preview sites (push local to WordPress.com):\n' +
    '  studio preview create --path PATH\n' +
    '  studio preview list/update/delete --path PATH\n\n' +
    'File editing: Site files at ~/Studio/site-name/wp-content/{themes,plugins,uploads}/. ' +
    'You can directly Read/Edit/Write theme and plugin PHP, CSS, JS, JSON, and template files.\n\n' +
    'WordPress development tools (run via Bash with node):\n' +
    '  node ~/Developer/Projects/bond/bin/bond-validate-blocks --url SITE_URL --file PATH\n' +
    '  node ~/Developer/Projects/bond/bin/bond-screenshot --url SITE_URL --viewport desktop\n' +
    'Screenshots are saved to ~/Library/Application Support/bond/screenshots/.\n' +
    'To show a screenshot to the user, include it in your response as a markdown image: ![description](/absolute/path/to/screenshot.png)\n' +
    'Paths with spaces work fine in markdown images — the app handles encoding automatically.\n' +
    'After writing block content, always validate. After building a site, screenshot to verify.\n' +
    'When creating a site from scratch, follow the design workflow in the /wordpress skill.'

  const editMode = options.editMode ?? { type: 'full' }
  const tools = editMode.type === 'readonly' ? READ_TOOLS : ALL_TOOLS

  let modePrompt = ''
  if (editMode.type === 'readonly') {
    modePrompt = '\n\nThis session is in READ-ONLY mode. You can only use Read, Glob, Grep, WebSearch, and WebFetch. You cannot edit files, write files, or run shell commands.'
  } else if (editMode.type === 'scoped') {
    modePrompt = `\n\nThis session is in SCOPED WRITE mode. Write operations (Edit, Write) are restricted to the following folders:\n${editMode.allowedPaths.map(p => `- ${p}`).join('\n')}\nBash commands still require user approval. Do not attempt to write to files outside these folders.`
  }

  const soul = getSoul().trim()
  const base = basePrompt + modePrompt + siteContext
  const systemPrompt = soul
    ? `${base}\n\n<soul>\n${soul}\n</soul>`
    : base

  const queryOptions: Record<string, unknown> = {
    abortController: ac,
    cwd,
    tools: [...tools],
    allowedTools: [...tools],
    model: options.model,
    includePartialMessages: true,
    permissionMode: 'default',
    systemPrompt,
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      sdkOptions: { title?: string; description?: string }
    ) => {
      if (!WRITE_TOOLS.has(toolName)) {
        return { behavior: 'allow' as const }
      }
      if (editMode.type === 'readonly') {
        return { behavior: 'deny' as const, message: 'Session is in read-only mode' }
      }
      if (editMode.type === 'scoped') {
        const targetPath = extractTargetPath(input)
        if (targetPath && !isWithinAllowedPaths(targetPath, editMode.allowedPaths)) {
          return { behavior: 'deny' as const, message: `Path ${targetPath} is outside allowed folders` }
        }
      }
      const requestId = randomUUID()
      options.onChunk({
        kind: 'tool_approval',
        requestId,
        toolName,
        input,
        title: sdkOptions.title,
        description: sdkOptions.description
      })
      return new Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>((resolve) => {
        pendingApprovals.set(requestId, { resolve, sessionId: options.sessionId ?? '' })
      })
    },
    stderr: (text: string) => {
      console.error('[bond] sdk stderr:', text.trimEnd())
    },
    plugins: [
      { type: 'local', path: resolve(getSkillsDir(), '..') }
    ],
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'bond-electron/0.1.0'
    } as Record<string, string | undefined>
  }

  if (options.sessionId) {
    if (options.resumeSession) {
      queryOptions.resume = options.sessionId
    } else {
      queryOptions.sessionId = options.sessionId
    }
  }

  let effectivePrompt = prompt

  if (options.imageIds?.length) {
    const imagePaths = getImagePaths(options.imageIds)
    if (imagePaths.length) {
      const imageList = imagePaths.map(p => `  - ${p}`).join('\n')
      const imageNote = `<attached-images>\nThe user attached ${imagePaths.length} image(s) to this message. You MUST read each file with the Read tool before responding:\n${imageList}\n</attached-images>`
      effectivePrompt = prompt ? `${imageNote}\n\n${prompt}` : imageNote
    }
  }

  const q = query({
    prompt: effectivePrompt,
    options: queryOptions as any
  })

  options.abortSignal.addEventListener(
    'abort',
    () => {
      clearSessionApprovals(options.sessionId ?? '')
      ac.abort()
      try {
        q.close()
      } catch {
        /* ignore */
      }
    },
    { once: true }
  )

  let chunkCount = 0
  let succeeded = false
  try {
    for await (const message of q) {
      if (options.abortSignal.aborted) break
      for (const chunk of bondMessageToChunks(message)) {
        chunkCount++
        if (chunk.kind === 'result' && chunk.subtype === 'success') {
          succeeded = true
        }
        options.onChunk(chunk)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[bond] query error:', msg)
    options.onChunk({ kind: 'raw_error', message: msg })
  }
  if (chunkCount === 0) {
    console.warn('[bond] query completed with no chunks emitted')
  }

  return succeeded
}
