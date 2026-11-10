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

export type OnboardingStepId = 'welcome' | 'boat' | 'prepare' | 'agent' | 'github' | 'tunnel' | 'done'

export const ONBOARDING_STEPS: OnboardingStepId[] = ['welcome', 'boat', 'prepare', 'agent', 'github', 'tunnel', 'done']

/** Remembered in this browser/webview: the owner pressed Get started, or skipped the public URL. */
export const WELCOMED_KEY = 'dorks.welcomed'
export const TUNNEL_SKIPPED_KEY = 'dorks.tunnelSkipped'

export interface OnboardingFlags {
  welcomed: boolean
  tunnelSkipped: boolean
}

export const readFlags = (): OnboardingFlags => ({
  welcomed: localStorage.getItem(WELCOMED_KEY) === '1',
  tunnelSkipped: localStorage.getItem(TUNNEL_SKIPPED_KEY) === '1',
})

/** Whether each onboarding step needs nothing more from the owner. `done` is never done: it is where the flow ends. */
export const onboardingDone = (s: Settings, f: OnboardingFlags): Record<OnboardingStepId, boolean> => {
  const d = stepDone(s)
  return {
    // Anything already configured means this is not a first run, so skip the greeting.
    welcome: f.welcomed || d.boat || d.snapshot || d.agents || d.github,
    boat: d.boat,
    prepare: d.snapshot,
    agent: d.agents,
    github: d.github,
    tunnel: s.publicUrlConfigured || f.tunnelSkipped,
    done: false,
  }
}

/** Where a returning owner resumes: the first step that is not done, ending at `done`. */
export const firstOnboardingStep = (s: Settings, f: OnboardingFlags): OnboardingStepId =>
  ONBOARDING_STEPS.find((id) => !onboardingDone(s, f)[id]) ?? 'done'
