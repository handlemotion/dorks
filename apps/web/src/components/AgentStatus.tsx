import type { DorkState } from '@dorks/shared'
import { WordShimmer } from './WordShimmer'

type Live = 'connecting' | 'live' | 'offline' | 'unauthorized'

/** What the sandbox is doing, in a word or two, and the dot colour that goes with it. Moving states shimmer and the dot changes shape. */
function describe(state: DorkState | undefined, live: Live | undefined): { label: string; tone: string; moving?: boolean } {
  if (live === 'offline' || live === 'connecting') return { label: 'Reconnecting to the server…', tone: 'bg-amber-500', moving: true }
  switch (state) {
    case 'creating':
      return { label: 'Starting the sandbox…', tone: 'bg-amber-500', moving: true }
    case 'waking':
      return { label: 'Waking the sandbox…', tone: 'bg-amber-500', moving: true }
    case 'working':
      return { label: 'Agent working', tone: 'bg-brand', moving: true }
    case 'idle':
      return { label: 'Sandbox ready', tone: 'bg-emerald-500' }
    case 'sleeping':
      return { label: 'Sandbox asleep, wakes on your next message', tone: 'bg-muted-foreground/50' }
    case 'error':
      return { label: 'Sandbox error', tone: 'bg-destructive' }
    default:
      return { label: 'Connecting…', tone: 'bg-muted-foreground/50', moving: true }
  }
}

/**
 * The line above the composer that says whether the cloud sandbox behind this chat is healthy, asleep, waking or reconnecting: a dot
 * and a few words (shimmering while something is moving, like the reconnect banner), announced politely to screen readers when it changes.
 */
export function AgentStatus({ state, live }: { state?: DorkState; live?: Live }) {
  const { label, tone, moving } = describe(state, live)
  return (
    <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm text-foreground" data-testid="agent-status">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone} ${moving ? 'status-shape' : ''}`} />
      {moving ? <span><WordShimmer>{label}</WordShimmer></span> : label}
    </p>
  )
}
