import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { CircleCheckIcon, CircleDashedIcon, CircleIcon, CircleMinusIcon, CircleXIcon, ExternalLinkIcon, LoaderCircleIcon, RocketIcon } from 'lucide-react'
import type { Block, ShipStage, ShipStageState, ShipView } from '@dorks/shared'
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
  // Tucked under the answer when the answer is the last thing above it; under a notice ("PR #7 merged") it keeps the notices' 12px rhythm.
  const above = blocks.filter((b) => b.kind !== 'turn' && b !== pinned).at(-1)?.kind
  const tuck = above === 'assistant' ? 'answer' : above === 'notice' ? 'notice' : undefined
  return (
    <PinnedShip.Provider value={pinned ? { id: pinned.ship.id, line: after } : null}>
      {children}
      {pinned && <ShipCard block={pinned} pinned tuck={tuck} />}
    </PinnedShip.Provider>
  )
}

/**
 * The session's latest ship, pinned at the end of the chat unless a turn is running (then it stays where the merge happened). Not
 * pinned once there is nothing to follow: a merge that started nothing, or a ship that ended before the owner wrote again.
 */
function pinnedShip(blocks: Block[], state: string): ShipBlock | undefined {
  if (state === 'working' || state === 'creating' || state === 'waking') return undefined
  let i = blocks.length - 1
  while (i >= 0 && blocks[i].kind !== 'ship') i--
  const b = blocks[i] as ShipBlock | undefined
  if (!b || b.ship.status === 'quiet') return undefined
  const ended = b.ship.endedAt
  const movedOn = ended !== undefined && blocks.slice(i + 1).some((x) => x.kind === 'user' && (x.at ?? 0) > ended)
  return movedOn ? undefined : b
}

/** Line icons while a stage waits or runs, filled ones once it passed (green) or failed (red). One table, so the set can be swapped. */
const STAGE_ICON: Record<ShipStageState, { icon: typeof CircleIcon; className: string; label: string }> = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground', label: 'Waiting' },
  running: { icon: LoaderCircleIcon, className: 'animate-spin text-muted-foreground motion-reduce:animate-none', label: 'Running' },
  // The stroke takes the card's fill, so the check and the x read as cut out of a filled circle.
  passed: { icon: CircleCheckIcon, className: 'fill-emerald-500 text-surface dark:fill-emerald-400', label: 'Passed' },
  failed: { icon: CircleXIcon, className: 'fill-red-500 text-surface dark:fill-red-400', label: 'Failed' },
  skipped: { icon: CircleMinusIcon, className: 'text-muted-foreground/60', label: 'Skipped' },
}

function headline(ship: ShipView) {
  const pr = `#${ship.number}`
  switch (ship.status) {
    case 'watching':
      return `Shipping ${pr}`
    case 'shipped':
      return `Shipped ${pr}`
    case 'failed':
      return `${pr} failed to ship`
    case 'stalled':
      return `${pr} still shipping after an hour`
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
export function ShipCard({ block, pinned = false, tuck }: { block: ShipBlock; pinned?: boolean; tuck?: 'answer' | 'notice' }) {
  const pin = useContext(PinnedShip)
  if (block.ship.status === 'quiet') return <ShipLine ship={block.ship} /> // nothing ran: there is nothing to list
  if (!pinned && pin?.id === block.ship.id) return pin.line ? <ShipLine ship={block.ship} /> : null
  return <ShipPanel ship={block.ship} tuck={pinned ? tuck : undefined} />
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

function ShipPanel({ ship, tuck }: { ship: ShipView; tuck?: 'answer' | 'notice' }) {
  const watching = ship.endedAt === undefined
  const now = useNow(watching)
  const time = watching ? workedFor(now - ship.startedAt) : ship.stages.length ? workedFor(lastEnd(ship.stages, ship.endedAt!) - ship.startedAt) : undefined
  const live = [...ship.stages].reverse().find((s) => s.kind === 'deployment' && s.state === 'passed' && s.environmentUrl)?.environmentUrl
  const bad = ship.status === 'failed' || ship.status === 'stalled'
  return (
    <section
      role={bad ? 'alert' : 'status'}
      aria-label={headline(ship)}
      data-testid="ship"
      data-status={ship.status}
      // pb-1.5: the last 28px row already leaves 4px under its text, so the card's text sits as far from its bottom edge as from its top.
      // Pinned right under the last answer, it belongs to it: it takes back most of the thread's gap (the answer keeps its time line).
      // Under a notice it sits 12px down, as the notices do from each other.
      className={`flex w-full min-w-0 flex-col gap-2 rounded-[6px] border border-surface-line bg-surface px-3.5 pt-2.5 pb-1.5 ${tuck === 'answer' ? '-mt-5' : tuck === 'notice' ? '-mt-3' : ''}`}
    >
      <p className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <span className={`min-w-0 truncate ${bad ? 'text-destructive' : ''}`}>{headline(ship)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          <a href={`https://github.com/${ship.repo}/commit/${ship.sha}`} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground">
            {ship.sha.slice(0, 7)}
          </a>
          {live && (
            <>
              <span aria-hidden>·</span>
              <a href={live} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">
                {host(live)}
                <ExternalLinkIcon aria-hidden className="size-3" />
              </a>
            </>
          )}
          {time && (
            <>
              <span aria-hidden>·</span>
              <span>{time}</span>
            </>
          )}
        </span>
      </p>
      <ul className="flex min-w-0 flex-col">
        {ship.stages.map((s) => (
          <li key={s.id}>
            <StageRow stage={s} now={now} />
          </li>
        ))}
        {!ship.stages.length && watching && (
          <li>
            <StageRow stage={{ id: 'waiting', kind: 'workflow', name: 'Waiting for workflows and deploys to start', state: 'pending' }} now={now} />
          </li>
        )}
      </ul>
    </section>
  )
}

function StageRow({ stage, now }: { stage: ShipStage; now: number }) {
  // The agent's note on its check is the point of that row: its own line under it, not a clipped detail.
  if (stage.kind === 'verify' && stage.detail) {
    return (
      <div className="flex min-w-0 flex-col pb-1">
        <StageRow stage={{ ...stage, detail: undefined }} now={now} />
        <p className="mt-1 pl-6 text-sm text-muted-foreground">{stage.detail}</p>
      </div>
    )
  }
  const look = STAGE_ICON[stage.state]
  const elapsed = stage.startedAt !== undefined && (stage.endedAt !== undefined || stage.state === 'running') ? workedFor((stage.endedAt ?? now) - stage.startedAt) : undefined
  const content = (
    <>
      {/* Optically placed: the circle sits 1px inside its box (so it lines up with the headline's left edge pulled back) and a 14px
          line's letters sit low in their box (so it comes down 1px to their middle). Offsets, so the name and the note keep their column. */}
      <look.icon aria-label={look.label} className={`relative top-px -left-px size-4 shrink-0 ${look.className}`} />
      <span className={`min-w-0 truncate ${stage.state === 'failed' ? 'text-destructive' : stage.state === 'pending' || stage.state === 'skipped' ? 'text-muted-foreground' : 'text-foreground'}`}>
        {stage.name}
      </span>
      {stage.detail && <span className="min-w-0 shrink truncate text-muted-foreground">{stage.detail}</span>}
      {elapsed && <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground tabular-nums">{elapsed}</span>}
    </>
  )
  const cls = 'flex h-7 min-w-0 items-center gap-2 text-sm'
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
