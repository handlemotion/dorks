import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import type { BuildView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Switch } from '@dorks/ui/switch'
import { SettingsGroup, SettingsGroupBody, SettingsRow, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { sizeOf, status, TONE_TEXT, runStatus, runTook, missingVars } from './format'
import { Dot, Facts } from './shared'

/** Why the build can't be used as it is: out of date, a value missing, or the last run's error. */
function Notices({ build }: { build: BuildView }) {
  const missing = missingVars(build)
  const stale = build.image?.stale ? build.image.staleReason : null
  const failed = !build.activeRun && build.lastRun?.status === 'failed' ? build.lastRun.error : null
  if (!stale && missing.length === 0 && !failed) return null
  return (
    <SettingsGroupBody>
      {stale && <p>{stale}.</p>}
      {missing.length > 0 && <p className="text-amber-700 dark:text-amber-400">Fill in {missing.join(', ')} below to build.</p>}
      {failed && (
        <pre role="alert" className="font-mono text-xs whitespace-pre-wrap text-destructive">
          {failed}
        </pre>
      )}
    </SettingsGroupBody>
  )
}

export function Overview({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const s = status(build)
  const last = build.lastRun
  return (
    <div className="flex flex-col gap-2.5">
      <SettingsGroup label="overview">
        <Facts
          items={[
            {
              label: 'Status',
              testId: 'build-status',
              value: (
                <>
                  <Dot tone={s.tone} />
                  <span className={cn('truncate', TONE_TEXT[s.tone])}>{s.text}</span>
                </>
              ),
            },
            {
              label: 'Size',
              value: sizeOf(build.machineType).short,
            },
            { label: 'Sessions on it', value: build.dorkCount },
            {
              label: 'Last run',
              value: last ? (
                <Link to="/builds" search={{ build: build.id, run: last.id }} className="truncate hover:underline hover:underline-offset-4">
                  {last.kind === 'image' ? 'Build' : 'Try'} {runStatus(last).toLowerCase()}
                  {last.finishedAt ? ` · ${runTook(last)}` : ''}
                </Link>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              ),
            },
          ]}
        />
        <Notices build={build} />
        <SettingsRow
          label="Use for new sessions"
          htmlFor="build-default"
          description={build.image ? undefined : 'Build it first.'}
          control={<Switch id="build-default" checked={build.isDefault} disabled={pending || !build.image} onCheckedChange={(on) => void run(() => actions.setDefaultBuild(build.id, on))} />}
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </div>
  )
}
