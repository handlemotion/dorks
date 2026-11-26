import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleCheckIcon, CircleDashedIcon, CircleIcon, CircleMinusIcon, CircleXIcon, ExternalLinkIcon, LoaderCircleIcon, RocketIcon } from 'lucide-react'
import type { Block, ShipStage, ShipStageState, ShipView } from '@dorks/shared'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { workedFor } from '../lib/duration'

// What a merged pull request set off (docs/shipping.md): the workflows on the merge commit, migrations, other apps' checks and
// deployments, as the server follows them. A card on the surface fill. While the agent works it sits where the merge happened; once
// the turn ends the session's latest ships are pinned at the end of the chat (`ShipPin`) and their place in the thread shrinks to a line.

/**
 * Cards in the thread (ships, builds, todos) bleed past the text column (`--card-bleed`, set on the transcript) by their inset, so
 * their outline sits just outside the column, what is inside lines up with the thread's text, and the sides are inset as much as the
 * top (10px inside the 1px border). Outside the transcript they keep the column and a 14px inset.
 */
export const CARD_BLEED = '-mx-[var(--card-bleed,0px)] w-[calc(100%+2*var(--card-bleed,0px))] px-[calc(var(--card-bleed,15px)-1px)]'

type ShipBlock = Extract<Block, { kind: 'ship' }>

/**
 * Ships that ran at the same time share one card: a PR that merged while the session's previous ship was still watched joins it, so two
 * merges in a row read as one release. Each group's card sits at its newest merge; the earlier merges' places show nothing. Not
 * grouped: a ship that ran nothing (`quiet`), which is one line of its own.
 */
function shipGroups(blocks: Block[]): ShipBlock[][] {
  const groups: ShipBlock[][] = []
  for (const b of blocks) {
    if (b.kind !== 'ship' || b.ship.status === 'quiet') continue
    const last = groups.at(-1)
    if (last?.some((g) => g.ship.endedAt === undefined || g.ship.endedAt >= b.ship.startedAt)) last.push(b)
    else groups.push([b])
  }
  return groups
}

/**
 * The thread's ship cards: each ship's group by ship id, and the group pinned at the end of the transcript. The pinned group's own
 * place in the thread shows one line instead of the card, or nothing when nothing follows it (the card is right there).
 */
type ShipsInThread = { groups: Map<number, ShipView[]>; pinned?: { id: number; line: boolean } }
const ShipsContext = createContext<ShipsInThread>({ groups: new Map() })

/**
 * The transcript with the session's latest ships pinned after it: while a turn runs the card stays where the merge happened; once the
 * turn ends it moves to the end of the chat, whole, and its place in the thread shrinks to a line.
 */
export function ShipPin({ blocks, state, children }: { blocks: Block[]; state: string; children: ReactNode }) {
  // Once per transcript: a new context value on every render made React look through the whole thread for its ship cards.
  const { value, pinned, anchor, tuck } = useMemo(() => {
    const groups = shipGroups(blocks)
    const pinned = pinnedGroup(blocks, groups.at(-1), state)
    const anchor = pinned?.at(-1)
    const after = anchor ? blocks.slice(blocks.indexOf(anchor) + 1).some((b) => b.kind !== 'turn') : false
    // Tucked under the answer when the answer is the last thing above it; under a notice ("PR #7 merged") it keeps the notices' 12px rhythm.
    const above = blocks.filter((b) => b.kind !== 'turn' && !pinned?.includes(b as ShipBlock)).at(-1)?.kind
    const tuck: 'answer' | 'notice' | undefined = above === 'assistant' ? 'answer' : above === 'notice' ? 'notice' : undefined
    const value: ShipsInThread = {
      groups: new Map(groups.flatMap((g) => g.map((b) => [b.ship.id, g.map((x) => x.ship)] as const))),
      pinned: anchor ? { id: anchor.ship.id, line: after } : undefined,
    }
    return { value, pinned, anchor, tuck }
  }, [blocks, state])
  return (
    <ShipsContext.Provider value={value}>
      {children}
      {pinned && anchor && <ShipCard block={anchor} pinned tuck={tuck} />}
    </ShipsContext.Provider>
  )
}

/**
 * The session's latest ships, pinned at the end of the chat unless a turn is running (then they stay where the merge happened). Not
 * pinned once there is nothing to follow: the latest merge started nothing, or they all ended before the owner wrote again.
 */
function pinnedGroup(blocks: Block[], group: ShipBlock[] | undefined, state: string): ShipBlock[] | undefined {
  if (state === 'working' || state === 'creating' || state === 'waking') return undefined
  const latest = blocks.findLast((b): b is ShipBlock => b.kind === 'ship')
  if (!group || !latest || !group.includes(latest)) return undefined
  const ends = group.map((b) => b.ship.endedAt)
  const ended = ends.every((e) => e !== undefined) ? Math.max(...(ends as number[])) : undefined
  const movedOn = ended !== undefined && blocks.slice(blocks.indexOf(latest) + 1).some((x) => x.kind === 'user' && (x.at ?? 0) > ended)
  return movedOn ? undefined : group
}

/** Line icons while a stage waits or runs, filled ones once it passed (green) or failed (red). One table, so the set can be swapped. */
export const STAGE_ICON: Record<ShipStageState, { icon: typeof CircleIcon; className: string; label: string }> = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground', label: 'Waiting' },
  running: { icon: LoaderCircleIcon, className: 'animate-spin text-muted-foreground motion-reduce:animate-none', label: 'Running' },
  // The stroke takes the card's fill, so the check and the x read as cut out of a filled circle.
  passed: { icon: CircleCheckIcon, className: 'fill-emerald-500 text-surface dark:fill-emerald-400', label: 'Passed' },
  failed: { icon: CircleXIcon, className: 'fill-red-500 text-surface dark:fill-red-400', label: 'Failed' },
  skipped: { icon: CircleMinusIcon, className: 'text-muted-foreground/60', label: 'Skipped' },
}

const prs = (ships: ShipView[]) => {
  const n = ships.map((s) => `#${s.number}`)
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`
}

/** One status for ships that share a card: a failure first, then a stall, then still shipping; shipped once all of them are. */
function groupStatus(ships: ShipView[]): ShipView['status'] {
  for (const s of ['failed', 'stalled', 'watching', 'quiet'] as const) if (ships.some((x) => x.status === s)) return s
  return 'shipped'
}

function headline(ships: ShipView[]) {
  switch (groupStatus(ships)) {
    case 'watching':
      return `Shipping ${prs(ships)}`
    case 'shipped':
      return `Shipped ${prs(ships)}`
    case 'failed':
      return `${prs(ships.filter((s) => s.status === 'failed'))} failed to ship`
    case 'stalled':
      return `${prs(ships.filter((s) => s.status === 'stalled'))} still shipping after an hour`
    case 'quiet':
      return `Nothing ran after merging ${prs(ships)}`
  }
}

/**
 * The rows of a card: every ship's stages, in merge order. A stage two merges share (a deploy that shipped both, a run that replaced a
 * cancelled one) has the same log and shows once, as the newest merge saw it; on a card for several merges, a row only one of them has
 * says which PR it is. The agent's checks are per PR, so they are never merged.
 */
function stageRows(ships: ShipView[]): { key: string; stage: ShipStage; pr?: string }[] {
  const rows = new Map<string, { stage: ShipStage; ships: ShipView[] }>()
  for (const ship of ships)
    for (const stage of ship.stages) {
      const key = stage.url && stage.kind !== 'verify' ? `${stage.kind} ${stage.name} ${stage.url}` : `${ship.id} ${stage.id}`
      const seen = rows.get(key)
      rows.set(key, { stage, ships: seen ? [...seen.ships, ship] : [ship] })
    }
  // Rows of the same name sit together (CI #7, CI #8), in the order the names first appear.
  const order = [...new Set([...rows.values()].map((r) => r.stage.name))]
  return [...rows]
    .toSorted(([, a], [, b]) => order.indexOf(a.stage.name) - order.indexOf(b.stage.name))
    .map(([key, r]) => ({ key, stage: r.stage, pr: ships.length > 1 && r.ships.length < ships.length ? prs(r.ships) : undefined }))
}

/** Ticks once a second while `on`, for the elapsed times of what is still running. */
export function useNow(on: boolean) {
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

/**
 * A ship in the thread: the card for its group at the group's newest merge (nothing at the earlier ones), or one line when the group is
 * pinned at the end of the chat.
 */
export function ShipCard({ block, pinned = false, tuck }: { block: ShipBlock; pinned?: boolean; tuck?: 'answer' | 'notice' }) {
  const { groups, pinned: pin } = useContext(ShipsContext)
  if (block.ship.status === 'quiet') return <ShipLine ships={[block.ship]} /> // nothing ran: there is nothing to list
  const ships = groups.get(block.ship.id) ?? [block.ship]
  if (ships.at(-1)!.id !== block.ship.id) return null
  if (!pinned && pin?.id === block.ship.id) return pin.line ? <ShipLine ships={ships} /> : null
  return <ShipPanel ships={ships} tuck={pinned ? tuck : undefined} />
}

function ShipLine({ ships }: { ships: ShipView[] }) {
  const status = groupStatus(ships)
  return (
    <Trace data-testid="ship-line" data-status={status} className="my-1.5">
      <TraceLine status={status === 'failed' || status === 'stalled' ? 'error' : undefined} className="text-(length:--text-message)">
        <TraceIcon>
          <RocketIcon />
        </TraceIcon>
        <TraceTitle>{headline(ships)}</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

function ShipPanel({ ships, tuck }: { ships: ShipView[]; tuck?: 'answer' | 'notice' }) {
  const watching = ships.some((s) => s.endedAt === undefined)
  const now = useNow(watching)
  const startedAt = Math.min(...ships.map((s) => s.startedAt))
  const stages = ships.flatMap((s) => s.stages)
  const endedAt = Math.max(...ships.map((s) => s.endedAt ?? 0))
  const time = watching ? workedFor(now - startedAt) : stages.length ? workedFor(lastEnd(stages, endedAt) - startedAt) : undefined
  const live = stages.findLast((s) => s.kind === 'deployment' && s.state === 'passed' && s.environmentUrl)?.environmentUrl
  const status = groupStatus(ships)
  const bad = status === 'failed' || status === 'stalled'
  const rows = stageRows(ships)
  return (
    <section
      role={bad ? 'alert' : 'status'}
      aria-label={headline(ships)}
      data-testid="ship"
      data-status={status}
      // pb-1.5: the last 28px row already leaves 4px under its text, so the card's text sits as far from its bottom edge as from its top.
      // Pinned right under the last answer it keeps 18px from it, as cards in a turn keep from text (the thread's 24px less a step); under
      // a notice it sits 12px down, as the notices do from each other. In the thread it takes the cards' 6px either side.
      className={`${CARD_BLEED} flex min-w-0 flex-col gap-2 rounded-[6px] border border-surface-line bg-surface pt-2.5 pb-1.5 ${tuck === 'answer' ? '-mt-1.5' : tuck === 'notice' ? '-mt-3' : 'my-1.5'}`}
    >
      <p className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <span className={`min-w-0 truncate ${bad ? 'text-destructive' : ''}`}>{headline(ships)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          {ships.map((ship, i) => (
            <Fragment key={ship.id}>
              {i > 0 && <span aria-hidden>·</span>}
              <a href={`https://github.com/${ship.repo}/commit/${ship.sha}`} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground">
                {ship.sha.slice(0, 7)}
              </a>
            </Fragment>
          ))}
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
        {rows.map((r) => (
          <li key={r.key}>
            <StageRow stage={r.stage} pr={r.pr} now={now} />
          </li>
        ))}
        {!rows.length && watching && (
          <li>
            <StageRow stage={{ id: 'waiting', kind: 'workflow', name: 'Waiting for workflows and deploys to start', state: 'pending' }} now={now} />
          </li>
        )}
      </ul>
    </section>
  )
}

function StageRow({ stage, pr, now }: { stage: ShipStage; pr?: string; now: number }) {
  // The agent's note on its check is the point of that row: its own line under it, not a clipped detail.
  if (stage.kind === 'verify' && stage.detail) {
    return (
      <div className="flex min-w-0 flex-col pb-1">
        <StageRow stage={{ ...stage, detail: undefined }} pr={pr} now={now} />
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
      {pr && <span className="shrink-0 text-muted-foreground tabular-nums">{pr}</span>}
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
