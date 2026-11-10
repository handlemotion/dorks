import type { DorkState, TurnOutcome } from '@dorks/shared'
import { WordShimmer } from './WordShimmer'

type Live = 'connecting' | 'live' | 'offline' | 'unauthorized'

/**
 * What the Dork is doing, said about the Dork (not its sandbox), and the dot colour that goes with it. Moving states shimmer and the
 * dot changes shape. `outcome` is how the latest turn ended: a turn the user stopped reads as Stopped, never as an error.
 */
function describeDork(name: string, state: DorkState | undefined, live: Live | undefined, outcome?: TurnOutcome | null): { label: string; tone: string; moving?: boolean } {
  if (live === 'offline' || live === 'connecting') return { label: 'Reconnecting to the server…', tone: 'bg-amber-500', moving: true }
  switch (state) {
    case 'creating':
      return { label: `${name} is starting up`, tone: 'bg-amber-500', moving: true }
    case 'waking':
      return { label: `${name} is waking up`, tone: 'bg-amber-500', moving: true }
    case 'working':
      return { label: `${name} is working`, tone: 'bg-brand', moving: true }
    case 'idle':
      return outcome === 'stopped'
        ? { label: `${name} stopped`, tone: 'bg-muted-foreground/50' }
        : { label: `${name} is waiting for your next message`, tone: 'bg-emerald-500' }
    case 'sleeping':
      return { label: `${name} is sleeping`, tone: 'bg-muted-foreground/50' }
    case 'error':
      return { label: `${name} ran into a problem`, tone: 'bg-destructive' }
    default:
      return { label: 'Connecting…', tone: 'bg-muted-foreground/50', moving: true }
  }
}

/**
 * The line at the end of the transcript that says what the Dork is doing: a dot and a few words (shimmering while something is
 * moving), announced politely to screen readers when it changes. `name` is the Dork's name when it has one.
 */
export function AgentStatus({ state, live, outcome, name = 'Dork' }: { state?: DorkState; live?: Live; outcome?: TurnOutcome | null; name?: string }) {
  const { label, tone, moving } = describeDork(name, state, live, outcome)
  return (
    <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm text-foreground" data-testid="agent-status">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone} ${moving ? 'status-shape' : ''}`} />
      {moving ? <span><WordShimmer>{label}</WordShimmer></span> : label}
    </p>
  )
}
