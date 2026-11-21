import { useEffect, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import type { DorkState, TurnOutcome } from '@dorks/shared'
import { workedFor } from './ChatBlock'
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
      return outcome === 'stopped' ? { label: `${name} stopped`, tone: 'bg-muted-foreground/50' } : { label: `${name} is waiting for your next message`, tone: 'bg-emerald-500' }
    case 'sleeping':
      return { label: `${name} is sleeping`, tone: 'bg-muted-foreground/50' }
    case 'error':
      return { label: `${name} ran into a problem`, tone: 'bg-destructive' }
    default:
      return { label: 'Connecting…', tone: 'bg-muted-foreground/50', moving: true }
  }
}

/** A second clock while `on`, for the step's running time. */
function useSeconds(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

/**
 * The line at the end of the transcript that says what the Dork is doing: a dot and a few words (shimmering while something is
 * moving), announced politely to screen readers when it changes. `name` is the Dork's name when it has one. While it works, the
 * words are the step it is on (`step`, "Running pnpm test") and how long that has run (`since`). With `onOpen` the line is a button,
 * a chevron after it, that opens Progress on that step.
 */
export function AgentStatus({
  state,
  live,
  outcome,
  name = 'Dork',
  step,
  since,
  onOpen,
}: {
  state?: DorkState
  live?: Live
  outcome?: TurnOutcome | null
  name?: string
  step?: string
  since?: number
  onOpen?: () => void
}) {
  const described = describeDork(name, state, live, outcome)
  const working = state === 'working' && !!described.moving && live !== 'offline' && live !== 'connecting'
  const label = working && step ? step : described.label
  const { tone, moving } = described
  const now = useSeconds(working && since !== undefined)
  const time = working && since !== undefined ? workedFor(now - since) : undefined
  const words = (
    <>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone} ${moving ? 'status-shape' : ''}`} />
      <span className="min-w-0 truncate">{moving ? <WordShimmer key={label}>{label}</WordShimmer> : label}</span>
      {/* Hidden from screen readers: a clock ticking every second would be read out each time. */}
      {time && (
        <span aria-hidden className="shrink-0 text-muted-foreground tabular-nums">
          {time}
        </span>
      )}
      {onOpen && <ChevronRightIcon aria-hidden className="-ml-1 size-3.5 shrink-0 text-muted-foreground" />}
    </>
  )
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 text-(length:--text-message) text-foreground" data-testid="agent-status">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title="Show in Progress"
          className="flex max-w-full min-w-0 items-center gap-2 rounded-(--control-radius) text-left outline-none hover:[&>svg]:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {words}
        </button>
      ) : (
        <p className="flex max-w-full min-w-0 items-center gap-2">{words}</p>
      )}
    </div>
  )
}
