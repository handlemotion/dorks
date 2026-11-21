import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckIcon, LoaderCircleIcon } from 'lucide-react'
import { useDorksClient, useSnapshot } from '@dorks/client/react'
import type { Settings, SnapshotStatus } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { stepDone } from '../lib/onboarding'
import { usePending } from '../lib/pending'
import { StepProgress } from './StepProgress'

type StepState = 'done' | 'running' | 'todo' | 'failed'

interface Step {
  id: string
  title: string
  state: StepState
  /** A short muted line under the title: what is happening, or what went wrong. */
  detail?: string
  /** On the right: a small button or a step count. */
  trailing?: ReactNode
}

/**
 * "Set up Dorks", under the new-session composer: every step between the owner and a working session, checked off as it
 * lands, with the Boat snapshot build shown in its row. It also appears, with everything else checked, while a newer app
 * rebuilds an existing snapshot. Renders nothing once every step is done and no build is running.
 */
export function SetupStatus({ settings }: { settings: Settings }) {
  const snap = useSnapshot()
  const steps = useSteps(settings, snap)
  if (!steps) return null
  const done = steps.filter((s) => s.state === 'done').length

  return (
    <section aria-label="Set up Dorks" data-testid="setup-checklist" className="flex flex-col gap-2 text-sm">
      <header className="flex h-7 items-center gap-3 px-3">
        <h3 className="flex-1">Set up Dorks</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {done} of {steps.length}
        </span>
        <div className="w-15">
          <StepProgress step={done} of={steps.length} label="Setup progress" tone="brand" />
        </div>
      </header>
      <ol className="flex flex-col rounded-(--control-radius) border border-border py-1">
        {steps.map((step) => (
          <li key={step.id} data-state={step.state} className="flex min-h-9 items-center gap-2 px-3 py-1.5">
            <StepMark state={step.state} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={step.state === 'done' ? 'text-muted-foreground' : undefined}>{step.title}</span>
              {step.detail && <span className={`text-xs ${step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{step.detail}</span>}
            </div>
            {step.trailing}
          </li>
        ))}
      </ol>
    </section>
  )
}

function StepMark({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <span aria-label="Done" className="grid size-3.5 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground">
        <CheckIcon className="size-2" strokeWidth={3.5} />
      </span>
    )
  if (state === 'running') return <LoaderCircleIcon aria-label="In progress" className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
  return <span aria-label={state === 'failed' ? 'Failed' : 'To do'} className={`size-3.5 shrink-0 rounded-full border ${state === 'failed' ? 'border-destructive' : 'border-input bg-muted'}`} />
}

const SettingsLink = ({ page, children }: { page: string; children: ReactNode }) => (
  <Button size="sm" variant="outline" render={<Link to="/settings/$page" params={{ page }} />} nativeButton={false}>
    {children}
  </Button>
)

/** The steps, or null when there is nothing to show. */
function useSteps(settings: Settings, snap: SnapshotStatus | undefined): Step[] | null {
  const { actions } = useDorksClient()
  const build = usePending()
  const d = stepDone(settings)
  const snapBusy = snap?.state === 'building' || snap?.state === 'failed'
  if (d.boat && d.agents && d.github && d.snapshot && !snapBusy) return null

  const buildButton = (label: string) => (
    <Button size="sm" variant="outline" disabled={build.pending || !snap?.canBuild} onClick={() => void build.run(async () => void (await actions.buildSnapshot()))}>
      {build.pending ? 'Starting…' : label}
    </Button>
  )
  const snapshot = snapshotStep(snap, d.boat, d.snapshot, buildButton)
  if (build.error) snapshot.detail = build.error

  const steps: Step[] = [
    accountStep('boat', 'Connect Boat', d.boat, 'boat', 'Connect'),
    accountStep('agents', 'Sign in to an AI account', d.agents, 'agents', 'Sign in'),
    accountStep('github', 'Connect GitHub', d.github, 'github', 'Connect'),
    snapshot,
  ]
  return steps
}

const accountStep = (id: string, title: string, done: boolean, page: string, action: string): Step => ({
  id,
  title,
  state: done ? 'done' : 'todo',
  trailing: done ? undefined : <SettingsLink page={page}>{action}</SettingsLink>,
})

/** Boat's base snapshot: built in the background once the key is saved, and again when a newer app needs a newer one. */
function snapshotStep(snap: SnapshotStatus | undefined, boat: boolean, have: boolean, buildButton: (label: string) => ReactNode): Step {
  if (snap?.state === 'building') {
    return {
      id: 'snapshot',
      title: have ? 'Updating Boat' : 'Preparing Boat',
      state: 'running',
      trailing: (
        <span className="truncate text-xs tabular-nums text-muted-foreground">
          {snap.message ?? 'Starting'} · {snap.stepIndex + 1} of {snap.stepCount}
        </span>
      ),
    }
  }
  if (snap?.state === 'failed') {
    const error = snap.error ?? 'The build failed'
    return {
      id: 'snapshot',
      title: have ? 'Updating Boat failed' : 'Preparing Boat failed',
      state: 'failed',
      detail: `${error}${/[.!?]$/.test(error) ? '' : '.'}${have ? ' Sessions keep using the previous one.' : ''}`,
      trailing: buildButton('Retry'),
    }
  }
  if (have) return { id: 'snapshot', title: 'Prepare Boat', state: 'done' }
  if (!boat) return { id: 'snapshot', title: 'Prepare Boat', state: 'todo', detail: 'Starts once Boat is connected.' }
  return { id: 'snapshot', title: 'Prepare Boat', state: 'todo', detail: snap?.cannotBuildReason ?? 'A few minutes, in the background.', trailing: buildButton('Prepare Boat') }
}
