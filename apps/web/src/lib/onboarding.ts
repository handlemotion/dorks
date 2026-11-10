import type { Settings } from '@dorks/client'

export type StepId = 'boat' | 'snapshot' | 'agents' | 'github'

export const STEPS: { id: StepId; title: string }[] = [
  { id: 'boat', title: 'Boat account' },
  { id: 'snapshot', title: 'Base snapshot' },
  { id: 'agents', title: 'Agent sign-in' },
  { id: 'github', title: 'GitHub' },
]

export const stepDone = (s: Settings): Record<StepId, boolean> => ({
  boat: s.boatKey,
  snapshot: !!s.baseSnapshotId,
  // One agent is enough to start. Claude (a token) is the default; a Boat ChatGPT environment alone also counts for Codex.
  agents: s.claudeToken || !!s.boatEnvironment,
  github: s.github.configured,
})

/** What creating a session needs. Agent sign-in is checked per provider when one is chosen. */
export const canCreate = (s: Settings) => s.boatKey && !!s.baseSnapshotId && s.github.configured

// ---- The full-page first-run flow (routes/_conn/onboarding.tsx) --------------------------------------------------------
//
// Only the things the owner has to type are steps. The base snapshot builds in the background once the Boat key is saved (the
// server starts it), and the public URL is asked for where sessions are created, the first time it is missing.

export type OnboardingStepId = 'intro' | 'boat' | 'agent' | 'github'

export const ONBOARDING_STEPS: OnboardingStepId[] = ['intro', 'boat', 'agent', 'github']

/** Remembered in this browser/webview: the owner pressed Get started on the intro. */
export const WELCOMED_KEY = 'dorks.welcomed'

export const readWelcomed = () => localStorage.getItem(WELCOMED_KEY) === '1'

/** Whether each onboarding step needs nothing more from the owner. */
export const onboardingDone = (s: Settings, welcomed: boolean): Record<OnboardingStepId, boolean> => {
  const d = stepDone(s)
  return {
    // Anything already configured means this is not a first run, so skip the intro.
    intro: welcomed || d.boat || d.snapshot || d.agents || d.github,
    boat: d.boat,
    agent: d.agents,
    github: d.github,
  }
}

/** Every onboarding step is answered: the app opens. The snapshot may still be building. */
export const onboarded = (s: Settings) => {
  const d = stepDone(s)
  return d.boat && d.agents && d.github
}

/** Where a returning owner resumes: the first step that is not done, or null when there is nothing left to ask. */
export const firstOnboardingStep = (s: Settings, welcomed: boolean): OnboardingStepId | null =>
  ONBOARDING_STEPS.find((id) => !onboardingDone(s, welcomed)[id]) ?? null
