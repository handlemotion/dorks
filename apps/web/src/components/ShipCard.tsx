import { useEffect, useState } from 'react'
import { CircleCheckIcon, CircleDashedIcon, CircleIcon, CircleMinusIcon, CircleXIcon, ExternalLinkIcon, LoaderIcon, RocketIcon, TriangleAlertIcon } from 'lucide-react'
import type { Block, ShipStage, ShipStageState } from '@dorks/shared'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@dorks/ui/trace'
import { workedFor } from '../lib/duration'

// What a merged pull request set off (docs/shipping.md): the workflows on the merge commit, migrations, other apps' checks and
// deployments, as the server follows them. One line in the thread that opens on its stages; open while something runs or failed.

type ShipBlock = Extract<Block, { kind: 'ship' }>

const STAGE_ICON: Record<ShipStageState, { icon: typeof CircleIcon; className: string; label: string }> = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground', label: 'Waiting' },
  running: { icon: LoaderIcon, className: 'animate-spin text-muted-foreground motion-reduce:animate-none', label: 'Running' },
  passed: { icon: CircleCheckIcon, className: 'text-muted-foreground', label: 'Passed' },
  failed: { icon: CircleXIcon, className: 'text-destructive', label: 'Failed' },
  skipped: { icon: CircleMinusIcon, className: 'text-muted-foreground/60', label: 'Skipped' },
}

/** Ticks once a second while `on`, for the elapsed time of what is still running. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function ShipCard({ block }: { block: ShipBlock }) {
  const { ship } = block
  const watching = ship.endedAt === undefined
  const now = useNow(watching)
  const pr = `#${ship.number}`
  const live = ship.stages.find((s) => s.kind === 'deployment' && s.state === 'passed' && s.environmentUrl)?.environmentUrl
  const took = ship.endedAt !== undefined ? workedFor(lastEnd(ship.stages, ship.endedAt) - ship.startedAt) : undefined
  const head = {
    watching: { title: `Shipping ${pr} to ${ship.baseRef}`, icon: RocketIcon, status: 'running' as const },
    shipped: { title: `Shipped ${pr} to ${ship.baseRef}`, icon: CircleCheckIcon, status: undefined },
    failed: { title: `${pr} failed to ship`, icon: CircleXIcon, status: 'error' as const },
    stalled: { title: `${pr} was still shipping after an hour`, icon: TriangleAlertIcon, status: 'error' as const },
    quiet: { title: `Nothing ran after merging ${pr}`, icon: CircleMinusIcon, status: undefined },
  }[ship.status]
  const open = ship.status === 'watching' || ship.status === 'failed' || ship.status === 'stalled'
  const line = (
    <TraceLine status={head.status} className="text-(length:--text-message)">
      <TraceIcon>
        <head.icon />
      </TraceIcon>
      <TraceTitle>{head.title}</TraceTitle>
      {ship.status === 'shipped' && took && <TraceDescription>in {took}</TraceDescription>}
    </TraceLine>
  )
  return (
    <Trace role={ship.status === 'failed' ? 'alert' : 'status'} data-testid="ship" data-status={ship.status} className="my-1.5">
      {ship.stages.length === 0 ? (
        line
      ) : (
        // Keyed on whether it should be open, so it folds itself away once shipped and opens again on a failure.
        <TraceCollapsible key={String(open)} defaultOpen={open}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="flex flex-col gap-0.5 pl-3">
            {ship.stages.map((s) => (
              <StageRow key={s.id} stage={s} now={now} />
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              <a href={`https://github.com/${ship.repo}/commit/${ship.sha}`} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground">
                {ship.sha.slice(0, 7)}
              </a>
              {watching ? ' · watching' : ''}
            </p>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
      {live && ship.status !== 'failed' && (
        <a href={live} target="_blank" rel="noreferrer" className="flex w-fit items-center gap-1.5 pl-6 text-sm text-muted-foreground hover:text-foreground">
          <span className="truncate">{live.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
          <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
        </a>
      )}
    </Trace>
  )
}

/** When the last stage finished: a settled ship is "shipped in" that long, not including the quiet wait after it. */
function lastEnd(stages: ShipStage[], fallback: number) {
  const ends = stages.flatMap((s) => (s.endedAt !== undefined ? [s.endedAt] : []))
  return ends.length ? Math.max(...ends) : fallback
}

function StageRow({ stage, now }: { stage: ShipStage; now: number }) {
  const look = STAGE_ICON[stage.state]
  const elapsed = stage.startedAt !== undefined ? workedFor((stage.endedAt ?? (stage.state === 'running' ? now : stage.startedAt)) - stage.startedAt) : undefined
  const content = (
    <>
      <look.icon aria-label={look.label} className={`size-3.5 shrink-0 ${look.className}`} />
      <span className={`min-w-0 truncate ${stage.state === 'failed' ? 'text-destructive' : 'text-foreground'}`}>{stage.name}</span>
      {stage.detail && <span className="min-w-0 shrink truncate text-muted-foreground">{stage.detail}</span>}
      {elapsed && stage.state !== 'pending' && stage.state !== 'skipped' && <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground tabular-nums">{elapsed}</span>}
    </>
  )
  const cls = 'flex h-6 min-w-0 items-center gap-2 text-sm'
  return stage.url ? (
    <a href={stage.url} target="_blank" rel="noreferrer" data-stage={stage.state} className={`${cls} rounded-[6px] hover:[&>span:first-of-type]:underline`}>
      {content}
    </a>
  ) : (
    <div data-stage={stage.state} className={cls}>
      {content}
    </div>
  )
}
