import { Link } from '@tanstack/react-router'
import type { BuildView } from '@dorks/client'
import { useDorksClient, useRuns } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { SettingsGroup, SettingsGroupBody, SettingsSection, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { ago, runStatus, runTook, byWhom } from './format'
import { LINK_ROW, Chevron, RunIcon } from './shared'

export function Runs({ build }: { build: BuildView }) {
  const runs = useRuns(build.id)
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <SettingsSection
      title="Runs"
      description="A try runs the setup on a throwaway machine, without saving it and without secrets."
      actions={
        <Button size="sm" variant="ghost" disabled={pending || !!build.activeRun} onClick={() => void run(() => actions.startRun(build.id, 'trial'))}>
          Try the setup
        </Button>
      }
    >
      <SettingsGroup label="runs">
        {runs && runs.length === 0 && <SettingsGroupBody>No runs yet.</SettingsGroupBody>}
        {runs?.map((r) => (
          <Link key={r.id} to="/builds" search={{ build: build.id, run: r.id }} className={LINK_ROW}>
            <RunIcon r={r} />
            <span className="w-12 shrink-0">{r.kind === 'image' ? 'Build' : 'Try'}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {runStatus(r)}
              {r.finishedAt && r.startedAt ? ` · ${runTook(r)}` : ''}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {byWhom(r)} · {ago(r.createdAt)}
            </span>
            <Chevron />
          </Link>
        ))}
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}
