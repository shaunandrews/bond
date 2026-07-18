export const ONBOARDING_FIRST_RUN_VERSION = 1

export type OnboardingFirstRunStatus = 'pending' | 'completed' | 'skipped' | 'existing-user'

export interface OnboardingFirstRunState {
  version: typeof ONBOARDING_FIRST_RUN_VERSION
  status: OnboardingFirstRunStatus
  updatedAt: string
}

/**
 * Seeded as Bond's first transcript message on a genuinely fresh install.
 * Everything after this is the real agent — the interview itself is driven by
 * the first-run section of the system prompt, not scripted turns.
 *
 * Bond is one long-running conversation, so the copy never says "sessions" or
 * "across conversations". It deliberately makes no assumptions about work or
 * productivity — "what I become depends on you" sets up the interview's
 * frame-picker question. The opener asks exactly one small question: a name.
 */
export const ONBOARDING_INTRO =
  'Hi, I’m Bond.\n\nI can help with almost anything—and I remember what matters, so you never have to repeat yourself. What I become depends on you. This is one ongoing conversation, and it gets better the longer we talk.\n\nFirst things first—what should I call you?'

export interface SandboxStatus {
  sandboxed: boolean
}
