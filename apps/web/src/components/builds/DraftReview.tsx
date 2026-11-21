import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRightIcon, GitBranchIcon, SparklesIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import type { BuildView, DraftView } from '@dorks/client'
import { useDorksClient, useRuns } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { PageHeader } from '../PageHeader'
import { SettingsGroup, SettingsGroupBody, SettingsInputRow, SettingsSection, SettingsStatus } from '../settings/kit'
import { usePending } from '../../lib/pending'
import { sizeOf, ago, firstLine, runStatus, runTook } from './format'
import { Tag, ROW, RowText, Page, BuildCrumb, RunIcon } from './shared'
import { type DiffLine, diffLines, repoChangesOf } from './diff'

function Diff({ lines, label }: { lines: DiffLine[]; label: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto py-2.5 font-mono text-xs leading-5">
      {lines.map((l, i) => (
        <span
          key={i}
          className={cn('block px-4 whitespace-pre', l.kind === '+' && 'bg-emerald-600/[0.08] text-emerald-800 dark:text-emerald-300', l.kind === '-' && 'bg-destructive/[0.07] text-destructive')}
        >
          {l.kind} {l.text}
        </span>
      ))}
    </pre>
  )
}

/** Who sent the change, what they say about it, and their latest trial. */
function DraftNote({ build, draft }: { build: BuildView; draft: DraftView }) {
  const runs = useRuns(build.id)
  const waiting = draft.status === 'editing'
  const trial = runs?.find((r) => r.startedBy === `dork:${draft.dorkId}` && r.kind === 'trial')
  return (
    <SettingsGroup label="agent draft">
      <div className="flex items-start gap-3 px-4 py-3.5">
        <SparklesIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          <span>
            From{' '}
            <Link to="/dorks" search={{ dork: draft.dorkId }} className="underline underline-offset-4">
              {draft.dorkTitle || 'a session'}
            </Link>{' '}
            <span className="text-muted-foreground">· {ago(draft.updatedAt)}</span>
          </span>
          {draft.note && <p className="text-message leading-relaxed whitespace-pre-wrap">{draft.note}</p>}
          {waiting && <p className="text-xs text-muted-foreground">The agent is still writing it.</p>}
          {draft.stale && <p className="text-xs text-amber-700 dark:text-amber-400">The build changed since the agent started from it.</p>}
        </div>
      </div>
      {trial && (
        <div className={ROW}>
          <RunIcon r={trial} />
          <span className="min-w-0 flex-1 truncate">
            Trial {runStatus(trial).toLowerCase()}
            <span className="text-muted-foreground">
              {trial.finishedAt ? ` · ${runTook(trial)}` : ''} · {ago(trial.createdAt)}
            </span>
          </span>
          <Button size="sm" variant="ghost" nativeButton={false} render={<Link to="/builds" search={{ build: build.id, run: trial.id }} />}>
            Open log
          </Button>
        </div>
      )}
    </SettingsGroup>
  )
}

/** An agent's change: its note and trial, what it changes against the build, and the owner's decision. */
export function DraftReview({ build, draft }: { build: BuildView; draft: DraftView }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const { run, pending, error } = usePending()
  const s = draft.spec
  const waiting = draft.status === 'editing'
  const script = s.setupScript !== build.setupScript ? diffLines(build.setupScript, s.setupScript) : null
  const added = script?.filter((l) => l.kind === '+').length ?? 0
  const removed = script?.filter((l) => l.kind === '-').length ?? 0
  const repoChanges = repoChangesOf(build.repos, s.repos)
  const sizeChanged = s.machineType !== build.machineType
  const nothing = !script && repoChanges.length === 0 && !sizeChanged && draft.vars.length === 0
  const back = () => navigate({ to: '/builds', search: { build: build.id } })
  const approve = () =>
    run(async () => {
      const r = await actions.approveDraft(build.id, draft.id, draft.updatedAt)
      if (r.missing.length) toast(`Approved. Fill in ${r.missing.join(', ')}, then build.`)
      await back()
    })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        parent={<BuildCrumb build={build} />}
        title={waiting ? 'Change in progress' : 'Change to review'}
        actions={
          !waiting && (
            <Button size="sm" disabled={pending} onClick={() => void approve()}>
              Approve and build
            </Button>
          )
        }
      />
      <Page>
        <DraftNote build={build} draft={draft} />

        {nothing && (
          <SettingsGroup>
            <SettingsGroupBody>No changes against the build.</SettingsGroupBody>
          </SettingsGroup>
        )}

        {script && (
          <SettingsSection
            title="Setup script"
            actions={
              <span className="font-mono text-xs tabular-nums">
                <span className="text-emerald-700 dark:text-emerald-400">+{added}</span> <span className="text-destructive">−{removed}</span>
              </span>
            }
          >
            <SettingsGroup>
              <Diff lines={script} label="setup script changes" />
            </SettingsGroup>
          </SettingsSection>
        )}

        {repoChanges.length > 0 && (
          <SettingsSection title="Repositories">
            <SettingsGroup label="repository changes">
              {repoChanges.map(({ r, what }) => (
                <div key={`${what}:${r.repo}`} className={ROW}>
                  <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <RowText
                    title={<span className="font-mono text-xs">{r.repo}</span>}
                    description={
                      <>
                        {r.branch ?? 'Default branch'}
                        {r.setupScript?.trim() ? (
                          <>
                            {' '}
                            · then <code className="font-mono">{firstLine(r.setupScript)}</code>
                          </>
                        ) : null}
                      </>
                    }
                  />
                  <Tag tone={what === 'Added' ? 'added' : what === 'Removed' ? 'removed' : undefined}>{what}</Tag>
                </div>
              ))}
            </SettingsGroup>
          </SettingsSection>
        )}

        {draft.vars.length > 0 && (
          <SettingsSection title="Variables">
            <SettingsGroup label="variable changes">
              {draft.vars.map((v) => (
                <div key={v.name} className={cn(ROW, 'flex-wrap md:flex-nowrap')}>
                  <code className="w-56 shrink-0 truncate font-mono text-xs">{v.name}</code>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {v.remove ? '' : v.value !== undefined && !v.secret ? <code className="font-mono text-foreground">{v.value}</code> : ''}
                    {v.why ? `${v.value !== undefined && !v.secret && !v.remove ? ' · ' : ''}${v.why}` : ''}
                  </span>
                  {v.remove ? <Tag tone="removed">Removed</Tag> : v.secret ? <Tag>Secret · you fill it in</Tag> : null}
                  {v.buildTime && !v.remove && <Tag>Build time</Tag>}
                </div>
              ))}
            </SettingsGroup>
          </SettingsSection>
        )}

        {sizeChanged && (
          <SettingsSection title="Machine">
            <SettingsGroup>
              <div className={ROW}>
                <span className="flex-1">Size</span>
                <span className="text-muted-foreground line-through">{sizeOf(build.machineType).short}</span>
                <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                <span>{sizeOf(s.machineType).short}</span>
              </div>
            </SettingsGroup>
          </SettingsSection>
        )}

        {!waiting && (
          <div className="flex flex-col gap-2.5">
            <SettingsGroup
              label="reject"
              onSubmit={() =>
                void run(async () => {
                  await actions.rejectDraft(build.id, draft.id, reason.trim() || undefined)
                  await back()
                })
              }
            >
              <SettingsInputRow
                id="reject-reason"
                aria-label="reason to reject"
                label="Reject"
                description="Optional reason. The agent reads it and tries again."
                placeholder="Why not"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                trailing={
                  <Button type="submit" size="sm" variant="outline" disabled={pending}>
                    Reject
                  </Button>
                }
              />
            </SettingsGroup>
            <SettingsStatus error={error} />
          </div>
        )}
      </Page>
    </div>
  )
}
