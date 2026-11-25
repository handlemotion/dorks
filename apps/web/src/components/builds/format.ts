import type { BuildView, MachineType, RunView } from '@dorks/client'
import { ago } from '../../lib/time'
import type { Tone } from '../settings/kit'

// `ago`, the tones and their colours are shared with Automations: lib/time.ts and the settings kit.
export { ago } from '../../lib/time'
export { TONE_TEXT, type Tone } from '../settings/kit'

// Pure helpers for the Builds pages: machine sizes, run steps, and how a build or a run reads.

export const SIZES: { value: MachineType; label: string; short: string; price: string }[] = [
  { value: 'small', label: 'Small · 2 CPU, 4 GB', short: 'Small · 2 CPU', price: '$0.018/h' },
  { value: 'default', label: 'Default · 4 CPU, 8 GB', short: 'Default · 4 CPU', price: '$0.036/h' },
  { value: 'large', label: 'Large · 8 CPU, 16 GB', short: 'Large · 8 CPU', price: '$0.072/h' },
  { value: 'xlarge', label: 'Extra large · 16 CPU, 32 GB', short: 'Extra large · 16 CPU', price: '$0.20/h, on Boat’s $100 plan' },
]
export const sizeOf = (m: MachineType) => SIZES.find((s) => s.value === m) ?? SIZES[1]

export const STEPS = ['prepare', 'create', 'start', 'clone', 'setup', 'scan', 'save', 'finish'] as const
export const STEP_NAMES: Record<string, string> = {
  prepare: 'Cleaning up',
  create: 'Creating a machine',
  start: 'Starting it',
  clone: 'Cloning repositories',
  setup: 'Running the setup',
  scan: 'Checking for secrets',
  save: 'Saving the image',
  finish: 'Finishing up',
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** An image run can start: nothing running, no build-time value missing, and not an agent's proposal the owner has not approved. */
export const canBuild = (b: BuildView, missing: string[]) => !b.activeRun && missing.length === 0 && (b.approved || !!b.image)

/** One line on where a build stands, and its colour, for the list and the build's page. */
export function status(b: BuildView): { text: string; tone: Tone } {
  if (b.activeRun)
    return {
      text: b.activeRun.status === 'queued' ? 'Waiting to build' : `${b.activeRun.kind === 'trial' ? 'Trying' : 'Building'}: ${STEP_NAMES[b.activeRun.step ?? ''] ?? 'starting'}`,
      tone: 'running',
    }
  if (!b.image && !b.approved) return { text: 'Waiting for your approval', tone: 'warning' }
  if (!b.image) return b.lastRun?.kind === 'image' && b.lastRun.status === 'failed' ? { text: 'Build failed', tone: 'danger' } : { text: 'Not built yet', tone: 'idle' }
  if (b.image.stale) return { text: 'Out of date', tone: 'warning' }
  return { text: `Built ${ago(b.image.at)}`, tone: 'success' }
}

export const firstLine = (s: string) => s.trim().split('\n')[0]

export const runStatus = (r: RunView) =>
  r.status === 'running' ? (STEP_NAMES[r.step ?? ''] ?? 'Running') : r.status === 'queued' ? 'Waiting' : r.status === 'succeeded' ? 'Succeeded' : r.status === 'cancelled' ? 'Cancelled' : 'Failed'
export const runTone = (r: RunView): Tone => (r.status === 'running' || r.status === 'queued' ? 'running' : r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'idle')
export const runTook = (r: RunView) => (r.startedAt ? duration((r.finishedAt ?? Date.now()) - r.startedAt) : '')
export const byWhom = (r: RunView) => (r.startedBy === 'owner' ? 'by you' : 'by an agent')

export const missingVars = (b: BuildView) => b.vars.filter((v) => v.buildTime && v.requested).map((v) => v.name)
