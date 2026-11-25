import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { CircleCheckIcon, CircleDashedIcon, CircleIcon, CircleMinusIcon, CircleXIcon, ExternalLinkIcon, LoaderIcon, RocketIcon, TriangleAlertIcon } from 'lucide-react'
import type { Block, ShipStage, ShipStageState, ShipView } from '@dorks/shared'
import { Button } from '@dorks/ui/button'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { workedFor } from '../lib/duration'

// What a merged pull request set off (docs/shipping.md): the workflows on the merge commit, migrations, other apps' checks and
// deployments, as the server follows them. A card on the surface fill. While the agent works it sits where the merge happened; once
// the turn ends the session's latest ship is pinned at the end of the chat (`PinnedShip`) and its place in the thread shrinks to a line.

type ShipBlock = Extract<Block, { kind: 'ship' }>

/**
 * The ship pinned at the end of the transcript. Its own place in the thread shows one line instead of the card, or nothing when nothing
 * follows it (the card is right there).
 */
export const PinnedShip = createContext<{ id: number; line: boolean } | null>(null)

/**
 * The transcript with the session's latest ship pinned after it: while a turn runs the card stays where the merge happened; once the
 * turn ends it moves to the end of the chat, whole, and its place in the thread shrinks to a line.
 */
export function ShipPin({ blocks, state, children }: { blocks: Block[]; state: string; children: ReactNode }) {
  const pinned = pinnedShip(blocks, state)
  const after = pinned ? blocks.slice(blocks.indexOf(pinned) + 1).some((b) => b.kind !== 'turn') : false
  return (
    <PinnedShip.Provider value={pinned ? { id: pinned.ship.id, line: after } : null}>
      {children}
      {pinned && <ShipCard block={pinned} pinned />}
    </PinnedShip.Provider>
  )
}

/** The session's latest ship, pinned at the end of the chat unless a turn is running (then it stays where the merge happened). */
function pinnedShip(blocks: Block[], state: string): ShipBlock | undefined {
  if (state === 'working' || state === 'creating' || state === 'waking') return undefined
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'ship') return b
  }
  return undefined
}

const STAGE_ICON: Record<ShipStageState, { icon: typeof CircleIcon; className: string; label: string }> = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground', label: 'Waiting' },
  running: { icon: LoaderIcon, className: 'animate-spin text-muted-foreground motion-reduce:animate-none', label: 'Running' },
  passed: { icon: CircleCheckIcon, className: 'text-muted-foreground', label: 'Passed' },
  failed: { icon: CircleXIcon, className: 'text-destructive', label: 'Failed' },
  skipped: { icon: CircleMinusIcon, className: 'text-muted-foreground/60', label: 'Skipped' },
}

const HEAD = {
  watching: { icon: LoaderIcon, className: 'animate-spin text-muted-foreground motion-reduce:animate-none' },
  shipped: { icon: CircleCheckIcon, className: 'text-muted-foreground' },
  failed: { icon: CircleXIcon, className: 'text-destructive' },
  stalled: { icon: TriangleAlertIcon, className: 'text-destructive' },
  quiet: { icon: CircleMinusIcon, className: 'text-muted-foreground' },
} as const

function headline(ship: ShipView) {
  const pr = `#${ship.number}`
  switch (ship.status) {
    case 'watching':
      return `Shipping ${pr} to ${ship.baseRef}`
    case 'shipped':
      return `Shipped ${pr} to ${ship.baseRef}`
    case 'failed':
      return `${pr} failed to ship`
    case 'stalled':
      return `${pr} was still shipping after an hour`
    case 'quiet':
      return `Nothing ran after merging ${pr}`
  }
}

/** Ticks once a second while `on`, for the elapsed times of what is still running. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** When the last stage finished: a settled ship took that long, not counting the quiet wait after it. */
function lastEnd(stages: ShipStage[], fallback: number) {
  const ends = stages.flatMap((s) => (s.endedAt !== undefined ? [s.endedAt] : []))
  return ends.length ? Math.max(...ends) : fallback
}

const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** A ship in the thread: the whole card, or one line when the same ship is pinned at the end of the chat. */
export function ShipCard({ block, pinned = false }: { block: ShipBlock; pinned?: boolean }) {
  const pin = useContext(PinnedShip)
  if (!pinned && pin?.id === block.ship.id) return pin.line ? <ShipLine ship={block.ship} /> : null
  return <ShipPanel ship={block.ship} />
}

function ShipLine({ ship }: { ship: ShipView }) {
  return (
    <Trace data-testid="ship-line" data-status={ship.status} className="my-1.5">
      <TraceLine status={ship.status === 'failed' || ship.status === 'stalled' ? 'error' : undefined} className="text-(length:--text-message)">
        <TraceIcon>
          <RocketIcon />
        </TraceIcon>
        <TraceTitle>{headline(ship)}</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

function ShipPanel({ ship }: { ship: ShipView }) {
  const watching = ship.endedAt === undefined
  const now = useNow(watching)
  const head = HEAD[ship.status]
  const time = watching ? workedFor(now - ship.startedAt) : ship.stages.length ? workedFor(lastEnd(ship.stages, ship.endedAt!) - ship.startedAt) : undefined
  const live = [...ship.stages].reverse().find((s) => s.kind === 'deployment' && s.state === 'passed' && s.environmentUrl)?.environmentUrl
  const failure = ship.stages.find((s) => s.state === 'failed' && s.url)
  const bad = ship.status === 'failed' || ship.status === 'stalled'
  return (
    <section
      role={bad ? 'alert' : 'status'}
      aria-label={headline(ship)}
      data-testid="ship"
      data-status={ship.status}
      className="flex w-full min-w-0 flex-col gap-3 rounded-[6px] border border-surface-line bg-surface px-4 py-3"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2.5 text-sm text-foreground">
          <head.icon aria-hidden className={`size-4 shrink-0 ${head.className}`} />
          <span className={`min-w-0 truncate ${bad ? 'text-destructive' : ''}`}>{headline(ship)}</span>
          {time && <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground tabular-nums">{time}</span>}
        </p>
        {ship.title && <p className="truncate pl-6.5 text-sm text-muted-foreground">{ship.title}</p>}
      </div>
      {ship.stages.length > 0 ? (
        <ul className="flex min-w-0 flex-col pl-6.5">
          {ship.stages.map((s) => (
            <li key={s.id}>
              <StageRow stage={s} now={now} />
            </li>
          ))}
        </ul>
      ) : (
        watching && <p className="pl-6.5 text-sm text-muted-foreground">Waiting for workflows and deploys on the merge commit to start.</p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2 pl-6.5">
        {live && ship.status !== 'failed' && (
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={live} target="_blank" rel="noreferrer" />}>
            Open {host(live)}
            <ExternalLinkIcon aria-hidden />
          </Button>
        )}
        {failure && (
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={failure.url} target="_blank" rel="noreferrer" />}>
            See why {failure.name} failed
          </Button>
        )}
        <p className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <a href={`https://github.com/${ship.repo}/commit/${ship.sha}`} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground">
            {ship.sha.slice(0, 7)}
          </a>
          {watching && <span>· {ship.status === 'failed' ? 'Watching for a re-run' : 'Watching'}</span>}
        </p>
      </div>
    </section>
  )
}

function StageRow({ stage, now }: { stage: ShipStage; now: number }) {
  // The agent's note on its check is the point of that row: its own line under it, not a clipped detail.
  if (stage.kind === 'verify' && stage.detail) {
    return (
      <div className="flex min-w-0 flex-col pb-1">
        <StageRow stage={{ ...stage, detail: undefined }} now={now} />
        <p className="pl-5.5 text-sm text-muted-foreground">{stage.detail}</p>
      </div>
    )
  }
  const look = STAGE_ICON[stage.state]
  const elapsed = stage.startedAt !== undefined && (stage.endedAt !== undefined || stage.state === 'running') ? workedFor((stage.endedAt ?? now) - stage.startedAt) : undefined
  const content = (
    <>
      <look.icon aria-label={look.label} className={`size-3.5 shrink-0 ${look.className}`} />
      <span className={`min-w-0 truncate ${stage.state === 'failed' ? 'text-destructive' : 'text-foreground'}`}>{stage.name}</span>
      {stage.detail && <span className="min-w-0 shrink truncate text-muted-foreground">{stage.detail}</span>}
      {elapsed && <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground tabular-nums">{elapsed}</span>}
    </>
  )
  const cls = 'flex h-6 min-w-0 items-center gap-2 text-sm'
  return stage.url ? (
    <a href={stage.url} target="_blank" rel="noreferrer" data-stage={stage.state} className={`${cls} hover:[&>span:first-of-type]:underline`}>
      {content}
    </a>
  ) : (
    <div data-stage={stage.state} className={cls}>
      {content}
    </div>
  )
}
