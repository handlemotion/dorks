import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckIcon, XIcon } from 'lucide-react'
import { cn } from 'cn'
import type { BuildView, RunView } from '@dorks/client'
import { useDorksClient, useRuns } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { EmptyState } from '../EmptyState'
import { PageHeader } from '../PageHeader'
import { usePending } from '../../lib/pending'
import { STEPS, STEP_NAMES, ago, runStatus, runTone, runTook, byWhom } from './format'
import { Dot, BuildCrumb, Facts } from './shared'
import { RunLog } from './RunLog'

/** Where each step of a run stands, from the step the run is on (or stopped at). */
function stepStates(r: RunView): ('done' | 'live' | 'failed' | 'stopped' | 'todo')[] {
  if (r.status === 'succeeded') return STEPS.map(() => 'done')
  const at = r.step ? STEPS.indexOf(r.step) : -1
  return STEPS.map((_, i) => {
    if (at < 0 || i > at) return 'todo'
    if (i < at) return 'done'
    return r.status === 'running' ? 'live' : r.status === 'failed' ? 'failed' : r.status === 'cancelled' ? 'stopped' : 'todo'
  })
}

export function RunPage({ build, runId }: { build: BuildView; runId: string }) {
  const runs = useRuns(build.id)
  const { actions } = useDorksClient()
  const { run: act, pending, error } = usePending()
  const r = runs?.find((x) => x.id === runId)
  const live = r?.status === 'queued' || r?.status === 'running'
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])
  if (!runs) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (!r)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader parent={<BuildCrumb build={build} />} title="Run" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="This run no longer exists">
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: build.id }} />}>
              Back to {build.name}
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  const states = stepStates(r)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        parent={<BuildCrumb build={build} />}
        title={`${r.kind === 'image' ? 'Build' : 'Try'} · ${ago(r.createdAt)}`}
        actions={
          live && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void act(() => actions.cancelRun(build.id, r.id))}>
              Cancel
            </Button>
          )
        }
      />
      <div className="border-b">
        <Facts
          items={[
            {
              label: 'Status',
              value: (
                <>
                  <Dot tone={runTone(r)} />
                  {runStatus(r)}
                </>
              ),
            },
            { label: 'Kind', value: r.kind === 'image' ? 'Build · saves an image' : 'Try · throwaway, no secrets' },
            { label: 'Started', value: `${byWhom(r)} · ${ago(r.createdAt)}` },
            { label: 'Duration', value: runTook(r) || '—' },
          ]}
        />
      </div>
      {(error || (r.status === 'failed' && r.error)) && (
        <div className="border-b px-5 py-3">
          <pre role="alert" className="font-mono text-xs whitespace-pre-wrap text-destructive">
            {error || r.error}
          </pre>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ol aria-label="steps" className="flex shrink-0 flex-col gap-0.5 border-b p-2 md:w-64 md:border-e md:border-b-0">
          {STEPS.map((step, i) => {
            const st = states[i]
            return (
              <li key={step} className={cn('flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 text-sm', st === 'live' && 'bg-foreground/[0.07]', st === 'todo' && 'text-muted-foreground')}>
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {st === 'done' ? (
                    <CheckIcon aria-label="Done" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : st === 'failed' ? (
                    <XIcon aria-label="Failed" className="size-3.5 text-destructive" />
                  ) : st === 'live' ? (
                    <Dot tone="running" />
                  ) : (
                    <span aria-hidden className="size-1.5 rounded-full border border-muted-foreground/60" />
                  )}
                </span>
                {STEP_NAMES[step]}
              </li>
            )
          })}
        </ol>
        <RunLog buildId={build.id} run={r} />
      </div>
    </div>
  )
}
