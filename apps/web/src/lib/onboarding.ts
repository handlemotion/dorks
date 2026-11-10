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
  // One agent is enough to start; Codex needs a Boat environment, Claude a token.
  agents: !!s.boatEnvironment || s.claudeToken,
  github: s.github.configured,
})

/** What creating a session needs. Agent sign-in is checked per provider when one is chosen. */
export const canCreate = (s: Settings) => s.boatKey && !!s.baseSnapshotId && s.github.configured

export const isSetupComplete = (s: Settings) => Object.values(stepDone(s)).every(Boolean)

export const firstIncomplete = (s: Settings): StepId | null => {
  const done = stepDone(s)
  return STEPS.find((step) => !done[step.id])?.id ?? null
}

/** Set by "Skip for now" so the dorks page does not bounce back to setup in the same browser session. */
export const SETUP_SKIPPED_KEY = 'dorks.setupSkipped'
