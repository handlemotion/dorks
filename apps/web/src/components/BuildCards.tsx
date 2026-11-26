import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { BoxIcon, HammerIcon } from 'lucide-react'
import { cn } from 'cn'
import type { Block, ChatRun, DraftChanges, RunStep } from '@dorks/shared'
import { Button } from '@dorks/ui/button'
import { workedFor } from '../lib/duration'
import { CARD_BLEED, STAGE_ICON, useNow } from './ShipCard'
import { sizeOf, STEP_NAMES } from './builds/format'

// Builds in the thread (docs/builds.md), cards on the surface fill like the to-dos and the ship card, told apart by the icon heading
// them: the machine change an agent submitted (its note and a short scrollable diff, taken when it submitted), and each build run of the
// session (its trials, and the image build approving the change set off) with its steps as they happen. The Builds page keeps the full
// review and the log.

type DraftBlock = Extract<Block, { kind: 'build' }>
type RunBlock = Extract<Block, { kind: 'buildRun' }>

// my-1.5: a card sits 18px from the text around it in a turn (12px gap plus 6px), so it never reads as part of a paragraph.
const CARD = `${CARD_BLEED} my-1.5 flex min-w-0 flex-col gap-2 rounded-[6px] border border-surface-line bg-surface pt-2.5`

/** The card's first line: what it is, then its state on the right. */
function Header({ icon: Icon, title, children }: { icon: typeof BoxIcon; title: string; children?: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 tabular-nums">{children}</span>
    </p>
  )
}

const Sep = () => <span aria-hidden>·</span>

/**
 * The agent asked the owner to approve a change to its machine. While it waits: the note, a short diff and Review the change. Once
 * approved, the image build that the approval started takes the diff's place, its steps live (an animated switch), so the change and
 * the build are one card.
 */
export function BuildDraftCard({ block }: { block: DraftBlock }) {
  const waiting = block.approved === null
  const state = waiting ? 'Waiting for you' : block.approved ? 'Approved' : 'Rejected'
  const run = block.approved ? block.run : undefined
  return (
    <section
      role={run?.status === 'failed' ? 'alert' : 'status'}
      aria-label={`Machine change to ${block.buildName}: ${run ? RUN_STATE[run.status] : state}`}
      data-testid="build-draft"
      data-state={state}
      data-run={run?.status}
      className={cn(CARD, run ? 'pb-1.5' : 'pb-3')}
    >
      <Header icon={BoxIcon} title={`${run ? 'Building the machine' : 'Machine change'} · ${block.buildName}`}>
        {run ? (
          <RunMeta run={run} />
        ) : (
          <span className={cn(block.approved === true && 'text-emerald-700 dark:text-emerald-400', block.approved === false && 'text-destructive', waiting && 'text-foreground')}>{state}</span>
        )}
      </Header>
      {block.note && <p className="text-sm leading-5 text-foreground">{block.note}</p>}
      {block.approved === false && block.reason && <p className="text-sm leading-5 text-muted-foreground">{block.reason}</p>}
      <AutoHeight>
        {run ? (
          <div key="steps" className="animate-in duration-300 fade-in slide-in-from-bottom-1 motion-reduce:animate-none">
            <RunSteps run={run} />
          </div>
        ) : (
          <ChangeBody key="change" block={block} />
        )}
      </AutoHeight>
    </section>
  )
}

/** What the change does, and the way to review it while it waits. */
function ChangeBody({ block }: { block: DraftBlock }) {
  const c = block.changes
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {c?.script && <ScriptDiff script={c.script} />}
      {c && <ChangeRows changes={c} />}
      {block.buildId && block.approved === null && (
        <div>
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: block.buildId }} />}>
            Review the change
          </Button>
        </div>
      )}
    </div>
  )
}

/** Eases its height to its content's, so a card that changes what it shows grows or shrinks instead of jumping. */
function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div style={{ height }} className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none">
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  )
}

/** A trial stops after the setup; an image build checks for secrets and saves the image. */
const TRIAL_STEPS: RunStep[] = ['prepare', 'create', 'start', 'clone', 'setup']
const IMAGE_STEPS: RunStep[] = ['prepare', 'create', 'start', 'clone', 'setup', 'scan', 'save', 'finish']

type StepState = keyof typeof STAGE_ICON

/** Where each step stands, from the step the run is on (or stopped at). */
function stepStates(run: ChatRun, steps: RunStep[]): StepState[] {
  if (run.status === 'succeeded') return steps.map(() => 'passed')
  const at = run.step ? steps.indexOf(run.step) : -1
  return steps.map((_, i) => {
    if (at < 0 || i > at) return run.status === 'failed' || run.status === 'cancelled' ? 'skipped' : 'pending'
    if (i < at) return 'passed'
    return run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'skipped' : 'pending'
  })
}

const RUN_STATE: Record<ChatRun['status'], string> = { queued: 'Waiting to start', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' }

/** A run's state, how long it took and the link to its log, for a card's header. */
function RunMeta({ run }: { run: ChatRun }) {
  const live = run.status === 'queued' || run.status === 'running'
  const now = useNow(live)
  const took = run.startedAt ? workedFor((run.finishedAt ?? now) - run.startedAt) : undefined
  return (
    <>
      <span className={cn(run.status === 'failed' && 'text-destructive', run.status === 'succeeded' && 'text-emerald-700 dark:text-emerald-400')}>{RUN_STATE[run.status]}</span>
      {took && (
        <>
          <Sep />
          <span>{took}</span>
        </>
      )}
      <Sep />
      <Link to="/builds" search={{ build: run.buildId, run: run.id }} className="hover:text-foreground">
        Log
      </Link>
    </>
  )
}

/** A run's steps as they stand, and its error once it failed. */
function RunSteps({ run }: { run: ChatRun }) {
  const steps = run.kind === 'image' ? IMAGE_STEPS : TRIAL_STEPS
  const states = stepStates(run, steps)
  return (
    <>
      <ol aria-label="steps" className="flex min-w-0 flex-col">
        {steps.map((step, i) => {
          const look = STAGE_ICON[states[i]]
          return (
            <li key={step} data-step={states[i]} className="flex h-7 min-w-0 items-center gap-2 text-sm">
              <look.icon aria-label={look.label} className={`relative top-px -left-px size-4 shrink-0 ${look.className}`} />
              <span className={cn('min-w-0 truncate', states[i] === 'failed' ? 'text-destructive' : states[i] === 'pending' || states[i] === 'skipped' ? 'text-muted-foreground' : 'text-foreground')}>
                {STEP_NAMES[step]}
              </span>
            </li>
          )
        })}
      </ol>
      {run.status === 'failed' && run.error && (
        <pre data-selectable className="mt-2 mb-2 max-h-32 overflow-auto rounded-[4px] bg-destructive/[0.05] px-2.5 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap text-destructive">
          {run.error}
        </pre>
      )}
    </>
  )
}

/** A build run of this session (its trials, or an image build), its steps updating as the server reports them; the log is on the Builds page. */
export function BuildRunCard({ block }: { block: RunBlock }) {
  const { run } = block
  const title = `${run.kind === 'image' ? 'Building the machine' : 'Trial run'} · ${run.buildName}`
  return (
    <section role={run.status === 'failed' ? 'alert' : 'status'} aria-label={`${title}: ${RUN_STATE[run.status]}`} data-testid="build-run" data-status={run.status} className={cn(CARD, 'pb-1.5')}>
      <Header icon={HammerIcon} title={title}>
        <RunMeta run={run} />
      </Header>
      <RunSteps run={run} />
    </section>
  )
}

/** A short window on the setup script's diff: it scrolls both ways, the Builds page has the whole thing. */
function ScriptDiff({ script }: { script: NonNullable<DraftChanges['script']> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Setup script</span>
        <span className="font-mono tabular-nums">
          <span className="text-emerald-700 dark:text-emerald-400">+{script.added}</span> <span className="text-destructive">−{script.removed}</span>
        </span>
      </p>
      {/* A short window on the diff: it scrolls both ways, the Builds page has the whole thing. */}
      <pre aria-label="setup script changes" data-selectable className="max-h-44 overflow-auto rounded-[4px] border border-surface-line bg-foreground/[0.03] py-1.5 font-mono text-xs leading-5">
        {script.lines.map((l, i) => (
          <span
            key={i}
            className={cn(
              'block min-w-max px-2.5 whitespace-pre',
              l.kind === '+' && 'bg-emerald-600/[0.08] text-emerald-800 dark:text-emerald-300',
              l.kind === '-' && 'bg-destructive/[0.07] text-destructive',
              l.kind === '…' && 'text-muted-foreground/70',
            )}
          >
            {l.kind === '…' ? `⋯ ${l.text}` : `${l.kind} ${l.text}`}
          </span>
        ))}
      </pre>
    </div>
  )
}

/** The repositories, services, variables and size the change touches, one short row each. */
function ChangeRows({ changes: c }: { changes: DraftChanges }) {
  const rows = [
    ...(c.repos ?? []).map((r) => ({ key: `repo:${r.name}`, what: r.what, label: 'repository', name: r.name })),
    ...(c.services ?? []).map((s) => ({ key: `svc:${s.name}`, what: s.what, label: 'service', name: s.name })),
    ...(c.vars ?? []).map((v) => ({ key: `var:${v.name}`, what: v.what, label: v.secret ? 'secret' : 'variable', name: v.name })),
  ]
  if (!rows.length && !c.size) return null
  return (
    <ul className="flex min-w-0 flex-col text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex h-6 min-w-0 items-center gap-2">
          <span className={cn('w-16 shrink-0 text-xs', r.what === 'Added' ? 'text-emerald-700 dark:text-emerald-400' : r.what === 'Removed' ? 'text-destructive' : 'text-muted-foreground')}>
            {r.what}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{r.label}</span>
          <code className="min-w-0 truncate font-mono text-xs">{r.name}</code>
        </li>
      ))}
      {c?.size && (
        <li className="flex h-6 min-w-0 items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">Changed</span>
          <span className="shrink-0 text-xs text-muted-foreground">size</span>
          <span className="min-w-0 truncate text-xs">
            {sizeOf(c.size.from).short} → {sizeOf(c.size.to).short}
          </span>
        </li>
      )}
    </ul>
  )
}
