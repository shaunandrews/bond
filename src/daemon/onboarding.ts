import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
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
 * Shared with the Pi runtime's tool allowlist: registering the tool is not
 * enough — activateRequestedTools() forces the session's active toolset to the
 * allowlist, so a name missing there is silently deactivated.
 */
export const ONBOARDING_TOOL_NAME = 'complete_onboarding'

export function getFirstRunStatus(): OnboardingFirstRunState {
  const existing = readFirstRunState()
  if (existing) return existing

  const status: OnboardingFirstRunStatus = hasExistingUserData() ? 'existing-user' : 'pending'
  return writeFirstRunState(status)
}

export function skipFirstRun(): OnboardingFirstRunState {
  return writeFirstRunState('skipped')
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
  if (getFirstRunStatus().status !== 'pending') return ''
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
    '7. The close — a real ending, not a fade-out: reflect back what you have learned in two or three human sentences as a statement, not another question. Then, in the SAME tool batch, make your memory_manage saves AND the complete_onboarding call (with soul) — never one without the other. Saving memories does NOT finish onboarding; only complete_onboarding does. Finish with one short line that lands plus one concrete offer of a first thing to do together, drawn from what they told you. The offer is theirs to take — do not start the work yourself.\n\n' +
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

/** Pi extension: lets the agent mark first-run onboarding finished. */
export function registerOnboardingTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ONBOARDING_TOOL_NAME,
    label: 'Complete Onboarding',
    description: 'Mark first-run onboarding as finished after you have learned about the user and saved durable memories. Optionally seeds Bond\'s initial soul from the conversation. Call exactly once, only during first-run onboarding.',
    parameters: Type.Object({
      soul: Type.Optional(Type.String({
        description: 'Initial soul: a few short lines of guidance on how Bond should be with this specific user, grounded in what they said during onboarding.',
      })),
    }),
    async execute(_toolCallId, params) {
      const soul = params.soul?.trim()
      // Seed only — never clobber a soul the user already wrote themselves.
      if (soul && !getSoul().trim()) saveSoul(soul)
      const state = completeFirstRun()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(state) }],
        details: state,
      }
    },
  })
}

export function createOnboardingExtensionFactory() {
  return (pi: ExtensionAPI) => registerOnboardingTools(pi)
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
  return value === 'pending' || value === 'completed' || value === 'skipped' || value === 'existing-user'
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
