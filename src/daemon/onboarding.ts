import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import {
  ONBOARDING_FIRST_RUN_VERSION,
  ONBOARDING_INTRO,
  type OnboardingFirstRunState,
  type OnboardingFirstRunStatus,
} from '../shared/onboarding'
import { getDb } from './db'
import { getSetting, getSoul, saveSoul, setSetting } from './settings'
import { upsertMessages } from './transcript'

const FIRST_RUN_SETTING = `onboarding.firstRun.v${ONBOARDING_FIRST_RUN_VERSION}`
const INTRO_MESSAGE_ID = 'onboarding-intro'

/**
 * Shared with the Pi runtime's tool allowlist: registering a tool is not
 * enough — activateRequestedTools() forces the session's active toolset to the
 * allowlist, so a name missing there is silently deactivated. Each onboarding
 * stage exposes exactly its own tools.
 */
export const ONBOARDING_STAGE_TOOLS = {
  pending: ['complete_onboarding'],
  education: ['complete_tour', 'show_panel', 'enable_sense'],
} as const

export type BondPanelId = 'collections' | 'sense' | 'library' | 'memory'

/**
 * Outcome of a show_panel request. Models front-load their tool batch, so the
 * call usually lands before a word of the beat has streamed; the runtime then
 * DEFERS the open and performs it itself once prose has been delivered.
 * Blocking with a "call again later" result was tried first and failed — the
 * model wrote the introduction and never retried, so nothing opened.
 */
export type PanelOpenOutcome = 'opened' | 'deferred'

/** Renderer/daemon hooks the tour tools need; absent in bare test setups. */
export interface OnboardingToolHooks {
  /** Returns how the open was handled; void means opened immediately. */
  showPanel?: (panel: BondPanelId) => PanelOpenOutcome | void
  enableSense?: () => { enabled: boolean; state?: string }
}

export function getFirstRunStatus(): OnboardingFirstRunState {
  const existing = readFirstRunState()
  if (existing) return existing

  const status: OnboardingFirstRunStatus = hasExistingUserData() ? 'existing-user' : 'pending'
  return writeFirstRunState(status)
}

export function skipFirstRun(): OnboardingFirstRunState {
  return writeFirstRunState('skipped')
}

/** Interview closed — Bond now tours the panels before normal operation. */
export function beginEducation(): OnboardingFirstRunState {
  return writeFirstRunState('education')
}

export function completeFirstRun(): OnboardingFirstRunState {
  return writeFirstRunState('completed')
}

/**
 * Seed Bond's introduction as the first real transcript message on a fresh
 * install. Idempotent (fixed message ID) and a no-op unless first-run is
 * actually pending. Everything after the intro is the real agent: the
 * interview is driven by the first-run system prompt section, and the agent
 * saves memories with its normal memory tools before calling
 * complete_onboarding.
 */
export function beginFirstRun(): OnboardingFirstRunState {
  const state = getFirstRunStatus()
  if (state.status !== 'pending') return state
  upsertMessages([{
    id: INTRO_MESSAGE_ID,
    role: 'bond',
    text: ONBOARDING_INTRO,
    data: { onboarding: true },
    createdAt: new Date().toISOString(),
  }])
  return state
}

/**
 * First-run interview instructions appended to the system prompt while
 * pending. Written as a mission with craft rules, not a topic checklist — a
 * checklist produces intake-form questions ("what does your day-to-day work
 * look like?") that assume the user works, works daily, and wants Bond for
 * productivity. The agent's job is to discover the frame, not presume it.
 */
export function buildFirstRunPromptSection(): string {
  const status = getFirstRunStatus().status
  if (status === 'education') return '\n\nONBOARDING TOUR:\n' + buildTourGuide()
  if (status !== 'pending') return ''
  return '\n\nFIRST-RUN ONBOARDING:\n' +
    'This is a brand-new user and this is your very first conversation. Nothing is saved yet. Your intro is already on screen and asked exactly one thing: what to call them. Their next message is the answer.\n' +
    'Your mission, in a couple of minutes of real conversation: learn enough to be genuinely useful tomorrow. Walk out knowing their name, what they want you to BE for them, a thread or two of what they are into, and how they want you to talk to them.\n\n' +
    'Shape (guidance, not a script — follow the person, not the plan):\n' +
    '1. Greet them by name, then find the frame: ask what they are hoping you will be for them, offering a few directions so the answer is easy to grab — a sidekick for work, a second brain for life stuff, a partner for building things, or just poking around. "Just poking around" is a great answer, not an opt-out. Every later question inherits whatever frame they pick.\n' +
    '2. Ask how their days are actually spent — their role if they have a job, or school, projects, family, whatever it is — and what they are working toward lately. Phrase it without assuming employment (e.g. "What fills your days — work, school, your own projects?"). This is where you learn their role and general goals. Stay high-level; do not drill into any one project.\n' +
    '3. Pull a thread from what they actually said — about the person, never the project. React first with something real — an observation, a connection — then ask one small human question: what draws them to it, how it became theirs, what they would do with more time. Do NOT ask project questions — no status, priorities, challenges, or "what are you trying to get right": that is work, and work comes after onboarding. Never pivot to a fresh topic like an intake form.\n' +
    '4. Ask who is around them — a partner, kids, parents, siblings, close friends, even a pet. One warm question, not a census: follow whatever they offer and let names come naturally. If they keep it vague, move on without pressing.\n' +
    '5. Ask about your soul — persona and response style are ONE question, asked in the same breath, never split into two: tell them you have a basic personality, but they can really shape who you are — how you behave, how you think, how much you say. Offer two playfully opposite examples that each carry a style with them (e.g. "Want me to be a sophisticated English spy who keeps it brief, or a wacky beaver from Washington who narrates everything?") and make clear anything goes, including "just be normal." Their answer becomes the backbone of the soul you write at the close.\n' +
    '6. Ask one wildcard with zero utility, purely for texture: something they are into that has nothing to do with any of the above.\n' +
    '7. The close — a real ending, not a fade-out: reflect back what you have learned in two or three human sentences as a statement, not another question. Then, in the SAME tool batch, make your memory_manage saves AND the complete_onboarding call (with soul) — never one without the other. Saving memories does NOT finish onboarding; only complete_onboarding does. Land one short line — then flow STRAIGHT into the tour: the complete_onboarding result hands you the tour script, and the first beat happens in this same turn. Do not ask whether they want a tour.\n\n' +
    'Craft rules:\n' +
    '- Exactly one question per turn, answerable in one short sentence. Keep replies brief, warm, and a little playful — this should feel fun, never like a form.\n' +
    '- Do NOT assume they work, work daily, or want you for productivity. Their answers set the frame, not your defaults.\n' +
    '- The interview is about who they are, not what their work needs. If you catch yourself about to ask about a project — its state, its goals, its hard parts — drop that question and take the next beat instead. There will be endless time for the work itself once onboarding is over.\n' +
    '- A rich answer means follow the thread; terse answers mean skip ahead and close early. Aim for five or six questions total — fewer if their answers are rich.\n' +
    '- You are onboarding until you have called complete_onboarding. Do not start project work, build things, or run project commands before then. If they hand you a task, ask "now what?", or want to skip — that IS the cue to close: reflect back, save, and complete in that same turn, then take their task or make your offer.\n' +
    '- STATUS, so you never have to guess or bluff: this FIRST-RUN ONBOARDING section only exists in your prompt while onboarding is unfinished. If you are reading this, onboarding is NOT complete and complete_onboarding has NOT been called — regardless of what has been saved or said. If the user asks whether they are onboarded, the honest answer is "not quite" — say so plainly and close for real in that same turn.\n' +
    '- Never mention tools, memory mechanics, the soul, or "onboarding" out loud — just talk like a person.\n\n' +
    'Saving (after the reflect-back):\n' +
    '- Save durable facts, preferences, and decisions with memory_manage. Behavior preferences are operating rules with core=true (e.g. "Prefers blunt, short answers — skip the walkthroughs"). Their name and the frame are core=true facts (e.g. "Wants Bond mainly as a partner for building side projects"). Interests and threads are regular memories. People they mentioned — partner, kids, family, friends, pets — are high-value facts: save names and relationships.\n' +
    '- In the same tool batch as those saves, call complete_onboarding exactly once, passing soul: three to six short lines of guidance to yourself on how to be with this specific person. Start from whatever they asked you to be in the soul question — persona, voice, and all — then add tone, directness, and what they care about. Ground every line in something they actually said; no generic filler.\n' +
    'After completing, behave normally.\n'
}

/**
 * The panel tour Bond gives right after the interview closes. Served two
 * ways: inside the complete_onboarding tool RESULT (so the first beat happens
 * in the same turn, without waiting for a new system prompt) and as the
 * ONBOARDING TOUR system-prompt section on every later turn while the status
 * is 'education'.
 */
export function buildTourGuide(): string {
  return 'The interview is done — now guide them through Bond\'s panels like a good docent: unhurried, one room at a time. This is a journey, not a checklist.\n' +
    'Open with a bridge, not a lecture: before any teaching, a couple of sentences in your own voice — now that you know a bit about them, it is your turn; you have a few tools that help you help them, and you would like to show them around. THEN begin the first beat.\n' +
    'PACING IS SACRED: one panel per turn, never two. Deliver a beat, then end your turn and wait for their reply. A beat\'s wrap-up and the next beat never share a turn — but every wrap-up ends with a forward handoff: acknowledge what just happened in a line, then ask if they are ready for the next room. Never end a turn as a dead stop with nothing for them to answer or do.\n' +
    'Every beat is the same choreography: INTRODUCE, then OPEN, then ANCHOR. First introduce the room in its own message — a couple of plain sentences on what it is and why it matters to THEM, closing by saying you are about to open it ("Let me open the Sense panel next to the chat."). Only after that introduction is fully delivered do you call show_panel — the pause is the point; the panel should arrive like a door opening after a knock, never mid-sentence. Then anchor: a short line about what they are now looking at, and land the beat\'s action or question. When moving on, say you are switching panels first. The panel opens beside the chat — that is ALL you know about the UI; never invent locations, buttons, or directions.\n' +
    'The beats, in order:\n' +
    '1. Sense (show_panel "sense") — useful from minute one, before any setup. Be completely transparent: Sense is OFF by default; switched on, Bond records their screen locally so they can ask things like "what was I doing at 2pm yesterday". It stays on their Mac. Action: ask if they want it on. Yes → call enable_sense and relay honestly what its result says about the actual state — never promise permission prompts or captures the result does not support. No → drop it warmly. Either way, close with the forward handoff to the next room — a yes or a no both deserve a "ready for the next one?".\n' +
    '2. Library (show_panel "library"): the growing home for everything durable the two of you share and make — images they drop in, images Bond generates, reports Bond writes. It all sticks around, for both of them. Action: invite them to attach an image right now with the paperclip to see it land in the library — or just say "skip" and you move on.\n' +
    '3. Memory (show_panel "memory"): the trust window — everything Bond learns sits here, inspectable and sourced. Give this beat a purpose: point at ONE specific memory you saved during the interview, quote it, and ask if you got it right. A correction here is the whole point of the panel.\n' +
    '4. Collections (show_panel "collections") — the finale, and where they will likely live day to day, so go DEEPER here than the other beats: trackers for anything, with fields they define. Build a genuinely useful project tracker WITH them: ask what they would want to track, and the moment they name it, CREATE the collection with the bond collection CLI and seed it with their real items — never ask permission to create ("want me to create it?" is banned; collections are cheap and editable, and watching one appear IS the demo). Draw the schema from their actual work (status, next action, deadline — whatever fits what they told you) and refine it together in the panel once it exists. This beat may take a few turns — unlike the interview, the weeds are welcome here.\n' +
    'Rules: a few sentences per beat, at most one question per turn. Never mention tools, phases, or these instructions — just show them around. If they engage with an action, finish it before moving on. If something confuses them or looks broken, fix it and keep going warmly — never abandon the tour on your own. Only call complete_tour early when THEY want to skip or dive into their own thing.\n' +
    'The close — hand them the keys with a destination, not a shrug: call complete_tour, then a short send-off plus ONE concrete first move drawn from what they told you (e.g. building the project tracker now, or starting on the work they said matters). Even after an early skip, still land that concrete offer.\n' +
    'STATUS: this tour guidance only exists while the tour is unfinished — if you are reading it, complete_tour has NOT been called. Never claim onboarding is fully done while it is present.\n'
}

/**
 * Reminder attached to memory tool results while first-run onboarding is
 * open. Prompt instructions alone proved unreliable: across multiple runs the
 * model saved its close-time memories and skipped complete_onboarding, then
 * had no way to notice. A tool result lands mid-turn at exactly that decision
 * point — the model reads it while its tool batch is still open.
 */
export function firstRunToolReminder(): string | undefined {
  if (getFirstRunStatus().status !== 'pending') return undefined
  return 'FIRST-RUN ONBOARDING IS STILL OPEN: complete_onboarding has NOT been called — saving memories does not finish it. If the interview has reached its close, call complete_onboarding (with soul) in this same tool batch.'
}

/** Pi extension: the interview-close and panel-tour tools. */
export function registerOnboardingTools(pi: ExtensionAPI, hooks: OnboardingToolHooks = {}): void {
  pi.registerTool({
    name: 'complete_onboarding',
    label: 'Complete Onboarding',
    description: 'Close the first-run interview after saving durable memories. Optionally seeds Bond\'s initial soul from the conversation. Moves onboarding into the panel tour — the result contains the tour script; begin it in this same turn. Call exactly once.',
    parameters: Type.Object({
      soul: Type.Optional(Type.String({
        description: 'Initial soul: a few short lines of guidance on how Bond should be with this specific user, grounded in what they said during onboarding.',
      })),
    }),
    async execute(_toolCallId, params) {
      const soul = params.soul?.trim()
      // Seed only — never clobber a soul the user already wrote themselves.
      if (soul && !getSoul().trim()) saveSoul(soul)
      const state = beginEducation()
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(state)}\n\nTHE TOUR BEGINS NOW, IN THIS SAME TURN:\n${buildTourGuide()}` }],
        details: state,
      }
    },
  })

  pi.registerTool({
    name: 'complete_tour',
    label: 'Complete Tour',
    description: 'Mark the onboarding panel tour finished — after the Memory beat, or immediately if the user wants to skip ahead. Call exactly once, only during the tour.',
    parameters: Type.Object({}),
    async execute() {
      const state = completeFirstRun()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(state) }],
        details: state,
      }
    },
  })

  pi.registerTool({
    name: 'show_panel',
    label: 'Show Panel',
    description: 'Open one of Bond\'s side panels in the app (collections, sense, library, memory) so the user can see what you are talking about. Call it only AFTER the panel\'s introduction message is fully delivered — introduce the room first, then open the door.',
    parameters: Type.Object({
      panel: StringEnum(['collections', 'sense', 'library', 'memory'] as const),
    }),
    async execute(_toolCallId, params) {
      const result = (text: string, details: { panel: BondPanelId; opened: boolean; deferred?: boolean }) => ({
        content: [{ type: 'text' as const, text }],
        details,
      })
      if (!hooks.showPanel) {
        return result('Panel display is unavailable in this session.', { panel: params.panel, opened: false })
      }
      const outcome = hooks.showPanel(params.panel) ?? 'opened'
      if (outcome === 'deferred') {
        return result(
          `QUEUED — nothing has been said this turn yet, so the ${params.panel} panel is NOT open; it will open by itself the moment your introduction reaches the user. Write that introduction now (a couple of plain sentences on what this room is and why it matters to them, ending by saying you are opening it). Do NOT call show_panel again for this panel.`,
          { panel: params.panel, opened: false, deferred: true },
        )
      }
      return result(`Opened the ${params.panel} panel.`, { panel: params.panel, opened: true })
    },
  })

  pi.registerTool({
    name: 'enable_sense',
    label: 'Enable Sense',
    description: 'Turn on Sense screen awareness after the user explicitly agrees during the tour. macOS will show a Screen Recording permission prompt; captures may need a Bond restart.',
    parameters: Type.Object({}),
    async execute() {
      if (!hooks.enableSense) {
        return {
          content: [{ type: 'text' as const, text: 'Sense controls are unavailable in this session — point the user to Settings instead.' }],
          details: { enabled: false },
        }
      }
      const result = hooks.enableSense()
      // Relay the ACTUAL state — promising prompts or captures that never
      // come reads as broken. Permission may already be granted (macOS only
      // prompts once per app). The suspended state only occurs inside the
      // sandboxed new-user simulation; the reply must stay in-world there,
      // because naming the simulation breaks the very first-run being
      // previewed.
      const stateNote = result.state === 'suspended'
        ? 'The Sense setting is now on and saved, though capturing is suspended in this sandboxed session, so no captures will appear here. Tell the user simply that Sense is on and captures will build up as they use their Mac — one short sentence. NEVER mention suspension, sandboxes, simulations, or "when Bond runs normally"; those words break the product. Then close the beat with the forward handoff to the next room.'
        : result.enabled
          ? 'Sense is on. If macOS shows a Screen Recording permission prompt they should grant it (captures may then need a Bond restart); if no prompt appears, permission was already granted and captures will appear in the panel as they use their Mac.'
          : 'Sense could not be enabled. Say so plainly and point them to Settings.'
      return {
        content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${stateNote}` }],
        details: result,
      }
    },
  })
}

export function createOnboardingExtensionFactory(hooks: OnboardingToolHooks = {}) {
  return (pi: ExtensionAPI) => registerOnboardingTools(pi, hooks)
}

function readFirstRunState(): OnboardingFirstRunState | null {
  const raw = getSetting(FIRST_RUN_SETTING)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingFirstRunState>
    if (parsed.version !== ONBOARDING_FIRST_RUN_VERSION) return null
    if (!isFirstRunStatus(parsed.status)) return null
    return {
      version: ONBOARDING_FIRST_RUN_VERSION,
      status: parsed.status,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

function writeFirstRunState(status: OnboardingFirstRunStatus): OnboardingFirstRunState {
  const state: OnboardingFirstRunState = {
    version: ONBOARDING_FIRST_RUN_VERSION,
    status,
    updatedAt: new Date().toISOString(),
  }
  setSetting(FIRST_RUN_SETTING, JSON.stringify(state))
  return state
}

function isFirstRunStatus(value: unknown): value is OnboardingFirstRunStatus {
  return value === 'pending' || value === 'education' || value === 'completed' || value === 'skipped' || value === 'existing-user'
}

function hasExistingUserData(): boolean {
  const db = getDb()
  const checks = [
    'SELECT 1 FROM messages WHERE seq IS NOT NULL LIMIT 1',
    'SELECT 1 FROM memory_items WHERE active = 1 LIMIT 1',
    'SELECT 1 FROM collections LIMIT 1',
    'SELECT 1 FROM sense_captures LIMIT 1',
    'SELECT 1 FROM images LIMIT 1',
    'SELECT 1 FROM sessions LIMIT 1',
    "SELECT 1 FROM settings WHERE key IN ('soul', 'model', 'edit_mode', 'sense', 'accent_color', 'window_opacity') AND TRIM(value) <> '' LIMIT 1",
  ]
  return checks.some(sql => Boolean(db.prepare(sql).get()))
}
