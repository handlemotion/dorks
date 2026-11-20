import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CheckIcon, ChevronRightIcon, CopyIcon, GitBranchIcon, KeyRoundIcon, PlusIcon, SearchIcon, SparklesIcon, Trash2Icon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import type { BuildRepo, BuildVarView, BuildView, DraftView, MachineType, RunView } from '@dorks/client'
import { useBuild, useBuilds, useDorks, useDorksClient, useGithubRepos, useRuns } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Checkbox } from '@dorks/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { NativeSelect, NativeSelectOption } from '@dorks/ui/native-select'
import { Switch } from '@dorks/ui/switch'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import {
  SettingsGroup,
  SettingsGroupBody,
  SettingsGroupFooter,
  SettingsInputRow,
  SettingsRow,
  SettingsSection,
  SettingsSections,
  SettingsSelectRow,
  SettingsStatus,
} from '../../../components/settings/kit'
import { usePending } from '../../../lib/pending'

// Builds (docs/builds.md): named machine setups a session can start from. Four pages on one route, laid out with the settings kit:
// the list (`/builds`), a build (`?build=<id>`), one of its runs with the log (`&run=<id>`), and an agent's change to review (`&review=<draft id>`).

type Search = { build?: string; run?: string; review?: string }

export const Route = createFileRoute('/_conn/_app/builds')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {}
    for (const k of ['build', 'run', 'review'] as const) if (typeof s[k] === 'string') out[k] = s[k] as string
    return out
  },
  component: Builds,
})

const SIZES: { value: MachineType; label: string; short: string }[] = [
  { value: 'small', label: 'Small · 2 CPU, 4 GB', short: 'Small · 2 CPU' },
  { value: 'default', label: 'Default · 4 CPU, 8 GB', short: 'Default · 4 CPU' },
  { value: 'large', label: 'Large · 8 CPU, 16 GB', short: 'Large · 8 CPU' },
  { value: 'xlarge', label: 'Extra large · 16 CPU, 32 GB', short: 'Extra large · 16 CPU' },
]
const sizeOf = (m: MachineType) => SIZES.find((s) => s.value === m) ?? SIZES[1]

const STEPS = ['prepare', 'create', 'start', 'clone', 'setup', 'scan', 'save', 'finish'] as const
const STEP_NAMES: Record<string, string> = {
  prepare: 'Cleaning up',
  create: 'Creating a machine',
  start: 'Starting it',
  clone: 'Cloning repositories',
  setup: 'Running the setup',
  scan: 'Checking for secrets',
  save: 'Saving the image',
  finish: 'Finishing up',
}

function ago(ms: number) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** An image run can start: nothing running, no build-time value missing, and not an agent's proposal the owner has not approved. */
const canBuild = (b: BuildView, missing: string[]) => !b.activeRun && missing.length === 0 && (b.approved || !!b.image)

type Tone = 'success' | 'running' | 'warning' | 'danger' | 'idle'

/** One line on where a build stands, and its colour, for the list and the build's page. */
function status(b: BuildView): { text: string; tone: Tone } {
  if (b.activeRun)
    return {
      text: b.activeRun.status === 'queued' ? 'Waiting to build' : `${b.activeRun.kind === 'trial' ? 'Trying' : 'Building'}: ${STEP_NAMES[b.activeRun.step ?? ''] ?? 'starting'}`,
      tone: 'running',
    }
  if (!b.image && !b.approved) return { text: 'Waiting for your approval', tone: 'warning' }
  if (!b.image) return b.lastRun?.kind === 'image' && b.lastRun.status === 'failed' ? { text: 'Build failed', tone: 'danger' } : { text: 'Not built yet', tone: 'idle' }
  if (b.image.stale) return { text: 'Out of date', tone: 'warning' }
  return { text: `Built ${ago(b.image.at)}`, tone: 'success' }
}

const TONE_TEXT: Record<Tone, string> = {
  success: '',
  running: '',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-destructive',
  idle: 'text-muted-foreground',
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'success' && 'bg-emerald-600 dark:bg-emerald-400',
        tone === 'running' && 'bg-brand',
        tone === 'warning' && 'bg-amber-600 dark:bg-amber-400',
        tone === 'danger' && 'bg-destructive',
        tone === 'idle' && 'border-[1.5px] border-muted-foreground/60',
      )}
    />
  )
}

function Tag({ children, tone }: { children: ReactNode; tone?: 'added' | 'removed' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-1.5 py-px text-xs',
        tone === 'added' ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400' : tone === 'removed' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/[0.05] text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

const ROW = 'flex min-h-13 w-full min-w-0 items-center gap-3 py-2.5 ps-4 pe-3 text-start text-sm'
const LINK_ROW = `${ROW} hover:bg-foreground/[0.025]`
const Chevron = () => <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />

/** Two lines: a title and a muted description, filling the row. */
function RowText({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate leading-4">{title}</span>
      {description && <span className="truncate text-xs leading-4 text-muted-foreground">{description}</span>}
    </div>
  )
}

/** The page body: the settings column. */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-16 sm:px-6">
        <SettingsSections>{children}</SettingsSections>
      </div>
    </div>
  )
}

function Builds() {
  const { build, run, review } = Route.useSearch()
  if (!build) return <BuildList />
  return <BuildPage id={build} run={run} review={review} />
}

// ---------------------------------------------------------------- the list

function BuildList() {
  const builds = useBuilds()
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending } = usePending()
  const [settingUp, setSettingUp] = useState(false)
  const create = () =>
    run(async () => {
      const taken = new Set(builds?.map((b) => b.name.toLowerCase()))
      let name = 'New build'
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New build ${n}`
      const { id } = await actions.createBuild({ name })
      await navigate({ to: '/builds', search: { build: id } })
    })
  const newButton = (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => void create()}>
      <PlusIcon data-icon="inline-start" />
      New build
    </Button>
  )
  if (builds && builds.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Builds" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="No builds yet" description="A build is a machine set up once: tools installed, variables set, repositories cloned.">
            {newButton}
          </EmptyState>
        </div>
      </div>
    )
  const reviews = builds?.flatMap((b) => b.drafts.filter((d) => d.status === 'submitted').map((d) => ({ b, d }))) ?? []
  const requested = builds?.flatMap((b) => b.vars.filter((v) => v.requested).map((v) => ({ b, v }))) ?? []
  const fallback = builds?.find((b) => b.isDefault)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Builds"
        actions={
          <>
            {fallback && (
              <Button size="sm" variant="ghost" onClick={() => setSettingUp(true)}>
                Set up with an agent
              </Button>
            )}
            {newButton}
          </>
        }
      />
      {fallback && <SetupDialog build={fallback} open={settingUp} onOpenChange={setSettingUp} />}
      <Page>
        {(reviews.length > 0 || requested.length > 0) && (
          <SettingsSection title="Needs you">
            <SettingsGroup label="needs you">
              {reviews.map(({ b, d }) => (
                <div key={d.id} className={ROW}>
                  <SparklesIcon aria-hidden className="size-4 shrink-0 text-brand" />
                  <RowText title={`An agent proposed changes to ${b.name}`} description={`${d.note ? `${firstLine(d.note)} · ` : ''}from ${d.dorkTitle || 'a session'} · ${ago(d.updatedAt)}`} />
                  <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: b.id, review: d.id }} />}>
                    Review
                  </Button>
                </div>
              ))}
              {requested.map(({ b, v }) => (
                <div key={`${b.id}:${v.name}`} className={ROW}>
                  <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                  <RowText
                    title={
                      <>
                        <code className="font-mono text-xs">{v.name}</code> is waiting for a value
                      </>
                    }
                    description={`${b.name} needs it${v.buildTime ? ' while building' : ''}`}
                  />
                  <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: b.id }} />}>
                    Fill in
                  </Button>
                </div>
              ))}
            </SettingsGroup>
          </SettingsSection>
        )}
        <SettingsSection title="Builds" description="A build is a machine set up once: tools installed, variables set, repositories cloned. Sessions start from its saved image.">
          <SettingsGroup label="builds">
            {builds?.map((b) => {
              const s = status(b)
              return (
                <Link key={b.id} to="/builds" search={{ build: b.id }} className={LINK_ROW}>
                  <Dot tone={s.tone} />
                  <RowText
                    title={
                      <>
                        {b.name}
                        {b.isDefault && <span className="ms-2 text-xs text-muted-foreground">Default</span>}
                      </>
                    }
                    description={b.repos.length ? <span className="font-mono">{b.repos.map((r) => r.repo).join(' · ')}</span> : 'No repositories'}
                  />
                  <span className="hidden w-32 shrink-0 text-xs text-muted-foreground md:block">{sizeOf(b.machineType).short}</span>
                  <span className={cn('w-44 shrink-0 truncate text-end text-xs', TONE_TEXT[s.tone])}>{s.text}</span>
                  <Chevron />
                </Link>
              )
            })}
          </SettingsGroup>
        </SettingsSection>
      </Page>
    </div>
  )
}

const firstLine = (s: string) => s.trim().split('\n')[0]

// ---------------------------------------------------------------- one build

function BuildPage({ id, run, review }: { id: string; run?: string; review?: string }) {
  const build = useBuild(id)
  if (build === undefined) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (build === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Builds" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="This build no longer exists">
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" />}>
              Back to builds
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  if (run) return <RunPage build={build} runId={run} />
  if (review) return <ReviewPage build={build} draftId={review} />
  return <BuildDetails build={build} />
}

const BuildCrumb = ({ build }: { build?: BuildView }) =>
  build ? (
    <Link to="/builds" search={{ build: build.id }} className="hover:text-foreground">
      {build.name}
    </Link>
  ) : (
    <Link to="/builds" className="hover:text-foreground">
      Builds
    </Link>
  )

/** A strip of facts across the top of a page: label over value, split by full hairlines. */
function Facts({ items }: { items: { label: string; value: ReactNode; testId?: string }[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4">
      {items.map((f) => (
        <div
          key={f.label}
          className="flex min-w-0 flex-col gap-1.5 border-e border-b px-4 py-3.5 text-sm [&:nth-child(2n)]:border-e-0 md:border-b-0 md:[&:nth-child(2n)]:border-e md:[&:nth-child(4n)]:border-e-0"
        >
          <span className="text-xs text-muted-foreground">{f.label}</span>
          <span data-testid={f.testId} className="flex min-w-0 items-center gap-2 truncate tabular-nums">
            {f.value}
          </span>
        </div>
      ))}
    </div>
  )
}

const runStatus = (r: RunView) =>
  r.status === 'running' ? (STEP_NAMES[r.step ?? ''] ?? 'Running') : r.status === 'queued' ? 'Waiting' : r.status === 'succeeded' ? 'Succeeded' : r.status === 'cancelled' ? 'Cancelled' : 'Failed'
const runTone = (r: RunView): Tone => (r.status === 'running' || r.status === 'queued' ? 'running' : r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'idle')
const runTook = (r: RunView) => (r.startedAt ? duration((r.finishedAt ?? Date.now()) - r.startedAt) : '')
const byWhom = (r: RunView) => (r.startedBy === 'owner' ? 'by you' : 'by an agent')

function BuildDetails({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, pending } = usePending()
  const missing = missingVars(build)
  const [settingUp, setSettingUp] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        parent={<BuildCrumb />}
        title={build.name}
        actions={
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSettingUp(true)}>
              Set up with an agent
            </Button>
            <SetupDialog build={build} open={settingUp} onOpenChange={setSettingUp} />
            {build.activeRun ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.cancelRun(build.id, build.activeRun!.id))}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" disabled={pending || !canBuild(build, missing)} onClick={() => void run(() => actions.startRun(build.id, 'image'))}>
                {build.image ? 'Rebuild' : 'Build'}
              </Button>
            )}
          </>
        }
      />
      <Page>
        <Overview build={build} />
        <AgentChanges build={build} />
        <Repositories build={build} />
        <SetupScript build={build} />
        <Variables build={build} />
        <SettingsSection title="Machine">
          <MachineSize build={build} />
        </SettingsSection>
        <Runs build={build} />
        <NameAndDelete build={build} />
      </Page>
    </div>
  )
}

const missingVars = (b: BuildView) => b.vars.filter((v) => v.buildTime && v.requested).map((v) => v.name)

/** Why the build can't be used as it is: out of date, a value missing, or the last run's error. */
function Notices({ build }: { build: BuildView }) {
  const missing = missingVars(build)
  const stale = build.image?.stale ? build.image.staleReason : null
  const failed = !build.activeRun && build.lastRun?.status === 'failed' ? build.lastRun.error : null
  if (!stale && missing.length === 0 && !failed) return null
  return (
    <SettingsGroupBody>
      {stale && <p>{stale}.</p>}
      {missing.length > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          Fill in {missing.join(', ')} below before building: the setup needs {missing.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {failed && (
        <pre role="alert" className="font-mono text-xs whitespace-pre-wrap text-destructive">
          {failed}
        </pre>
      )}
    </SettingsGroupBody>
  )
}

function Overview({ build }: { build: BuildView }) {
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
          description={build.image ? 'New sessions start on this build’s image instead of the base.' : 'Build it before sessions can start on it.'}
          control={<Switch id="build-default" checked={build.isDefault} disabled={pending || !build.image} onCheckedChange={(on) => void run(() => actions.setDefaultBuild(build.id, on))} />}
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </div>
  )
}

function AgentChanges({ build }: { build: BuildView }) {
  const drafts = [...build.drafts.filter((d) => d.status === 'submitted'), ...build.drafts.filter((d) => d.status === 'editing')]
  if (drafts.length === 0) return null
  return (
    <SettingsSection title="Agent changes">
      <SettingsGroup label="agent drafts">
        {drafts.map((d) => (
          <div key={d.id} className={ROW}>
            <SparklesIcon aria-hidden className="size-4 shrink-0 text-brand" />
            <RowText
              title={d.status === 'submitted' ? 'Change to review' : 'Change in progress'}
              description={`${d.note ? `${firstLine(d.note)} · ` : ''}from ${d.dorkTitle || 'a session'} · ${ago(d.updatedAt)}`}
            />
            <Button size="sm" variant={d.status === 'submitted' ? 'outline' : 'ghost'} nativeButton={false} render={<Link to="/builds" search={{ build: build.id, review: d.id }} />}>
              {d.status === 'submitted' ? 'Review' : 'View'}
            </Button>
          </div>
        ))}
      </SettingsGroup>
    </SettingsSection>
  )
}

function SetupScript({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [text, setText] = useState(build.setupScript)
  useEffect(() => setText(build.setupScript), [build.setupScript])
  const { run, pending, error } = usePending()
  return (
    <SettingsSection
      title="Setup script"
      description={
        <>
          Runs once while building, as <code>user</code> with passwordless sudo in <code>/home/user</code>. Stops at the first failing command.
        </>
      }
    >
      <SettingsGroup label="setup script form" onSubmit={() => void run(() => actions.updateBuild(build.id, { setupScript: text }))}>
        <Textarea
          aria-label="setup script"
          rows={8}
          spellCheck={false}
          className="max-w-none! min-h-40 rounded-none border-0 bg-app/30 px-4 py-3 font-mono text-xs leading-5 focus-visible:ring-0 dark:bg-app/30"
          placeholder="sudo apt-get install -y jq"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <SettingsGroupFooter
          action={
            <Button type="submit" size="sm" variant="outline" disabled={pending || text === build.setupScript}>
              Save
            </Button>
          }
        >
          {text !== build.setupScript ? 'Unsaved changes. Saving marks the image out of date until you rebuild.' : 'Saving marks the image out of date until you rebuild.'}
        </SettingsGroupFooter>
      </SettingsGroup>
      <SettingsStatus error={error} />
    </SettingsSection>
  )
}

function Repositories({ build }: { build: BuildView }) {
  const [editing, setEditing] = useState<BuildRepo | 'new' | null>(null)
  return (
    <SettingsSection
      title="Repositories"
      description={
        <>
          Cloned into <code>~/work/owner/name</code> when the machine is built. Sessions fetch before they start.
        </>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
          Add repository
        </Button>
      }
    >
      <SettingsGroup label="repositories">
        {build.repos.length === 0 && <SettingsGroupBody>No repositories yet. Each one is cloned and set up when the machine is built.</SettingsGroupBody>}
        {build.repos.map((r) => (
          <div key={r.repo} className={ROW}>
            <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <RowText
              title={<span className="font-mono text-xs">{r.repo}</span>}
              description={
                <>
                  {r.branch ?? 'Default branch'} ·{' '}
                  {r.setupScript?.trim() ? (
                    <>
                      then <code className="font-mono">{firstLine(r.setupScript)}</code>
                    </>
                  ) : (
                    'no setup'
                  )}
                </>
              }
            />
            <Button size="sm" variant="ghost" aria-label={`edit ${r.repo}`} onClick={() => setEditing(r)}>
              Edit
            </Button>
          </div>
        ))}
      </SettingsGroup>
      {editing && <RepoDialog build={build} repo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </SettingsSection>
  )
}

/** Adds a repository, or edits (or removes) one. */
function RepoDialog({ build, repo, onClose }: { build: BuildView; repo: BuildRepo | null; onClose: () => void }) {
  const { actions } = useDorksClient()
  const [name, setName] = useState(repo?.repo ?? '')
  const [branch, setBranch] = useState(repo?.branch ?? '')
  const [script, setScript] = useState(repo?.setupScript ?? '')
  const { run, pending, error } = usePending()
  const save = (repos: BuildRepo[]) =>
    run(async () => {
      await actions.updateBuild(build.id, { repos })
      onClose()
    })
  const next: BuildRepo = { repo: name.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(script.trim() ? { setupScript: script } : {}) }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void save(repo ? build.repos.map((r) => (r.repo === repo.repo ? next : r)) : [...build.repos, next])
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{repo ? `Edit ${repo.repo}` : 'Add a repository'}</DialogTitle>
            <DialogDescription className="text-sm leading-5">Cloned when the machine is built, then its setup runs inside the clone.</DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="repo-name">Repository</FieldLabel>
              <Input id="repo-name" aria-label="repository" placeholder="owner/name" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!repo} />
            </Field>
            <Field>
              <FieldLabel htmlFor="repo-branch">Branch</FieldLabel>
              <Input id="repo-branch" aria-label="branch" placeholder="The default branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="repo-setup">Setup in the clone</FieldLabel>
              <Textarea
                id="repo-setup"
                aria-label="repository setup"
                rows={3}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="pnpm install"
                value={script}
                onChange={(e) => setScript(e.target.value)}
              />
              <FieldDescription>Optional. Runs in the clone after the setup script.</FieldDescription>
            </Field>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {repo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="me-auto text-destructive"
                disabled={pending}
                aria-label={`remove ${repo.repo}`}
                onClick={() => void save(build.repos.filter((r) => r.repo !== repo.repo))}
              >
                Remove
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !name.trim()}>
              {repo ? 'Save' : 'Add repository'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Variables({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [adding, setAdding] = useState(false)
  const [filling, setFilling] = useState<BuildVarView | null>(null)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection
      title="Variables"
      description="Set in every session on this machine. Mark one as needed while building to also give it to the setup script. Secret values are never shown."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          Add variable
        </Button>
      }
    >
      <SettingsGroup label="variables">
        {build.vars.length === 0 && <SettingsGroupBody>No variables yet.</SettingsGroupBody>}
        {build.vars.map((v) => (
          <div key={v.name} className={cn(ROW, 'flex-wrap md:flex-nowrap')}>
            <code className="w-56 shrink-0 truncate font-mono text-xs">{v.name}</code>
            <span className={cn('min-w-0 flex-1 truncate', v.requested ? 'text-xs text-amber-700 dark:text-amber-400' : v.secret ? 'font-mono text-xs text-muted-foreground' : 'font-mono text-xs')}>
              {v.requested ? 'Waiting for a value' : v.secret ? '••••••••••••' : v.value || '(empty)'}
            </span>
            {v.secret && <Tag>Secret</Tag>}
            {v.buildTime && <Tag>Build time</Tag>}
            <Button size="sm" variant={v.requested ? 'outline' : 'ghost'} disabled={pending} onClick={() => setFilling(v)}>
              {v.requested ? 'Fill in' : v.secret ? 'Replace' : 'Edit'}
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={pending} aria-label={`remove ${v.name}`} onClick={() => void run(() => actions.deleteBuildVar(build.id, v.name))}>
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </SettingsGroup>
      <SettingsStatus error={error} />
      {adding && <VarDialog build={build} onClose={() => setAdding(false)} />}
      {filling && <VarDialog build={build} variable={filling} onClose={() => setFilling(null)} />}
    </SettingsSection>
  )
}

const varTitle = (v?: BuildVarView) => (!v ? 'Add a variable' : v.requested ? `Fill in ${v.name}` : `New value for ${v.name}`)

/** A new variable, or a new value for one. */
function VarDialog({ build, variable, onClose }: { build: BuildView; variable?: BuildVarView; onClose: () => void }) {
  const { actions } = useDorksClient()
  const [name, setName] = useState(variable?.name ?? '')
  const [value, setValue] = useState(variable && !variable.secret ? (variable.value ?? '') : '')
  const [secret, setSecret] = useState(variable?.secret ?? true)
  const [buildTime, setBuildTime] = useState(variable?.buildTime ?? false)
  const { run, pending, error } = usePending()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await actions.setBuildVar(build.id, name.trim(), variable ? { value } : { value, secret, buildTime })
              onClose()
            })
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{varTitle(variable)}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {variable?.secret ? 'Secret values are stored encrypted and never shown again.' : 'Set in every session on this machine.'}
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="flex flex-col gap-4">
            {!variable && (
              <Field>
                <FieldLabel htmlFor="var-name">Name</FieldLabel>
                <Input id="var-name" aria-label="variable name" placeholder="NAME_IN_CAPS" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="var-value">Value</FieldLabel>
              <Input
                id="var-value"
                aria-label={variable ? `value of ${variable.name}` : 'variable value'}
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                className="font-mono"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus={!!variable}
              />
            </Field>
            {!variable && (
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={secret} onCheckedChange={(c) => setSecret(c === true)} /> Secret
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={buildTime} onCheckedChange={(c) => setBuildTime(c === true)} /> Needed while building
                </label>
              </div>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !name.trim() || (!!variable && !value)}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MachineSize({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, error } = usePending()
  return (
    <>
      <SettingsGroup label="machine">
        <SettingsSelectRow
          label="Size"
          description="Billed per second while a session runs: $0.018/h small, $0.036/h default, $0.072/h large, $0.20/h extra large (needs Boat’s $100 plan)."
          value={build.machineType}
          options={SIZES}
          onValueChange={(v) => void run(() => actions.updateBuild(build.id, { machineType: v }))}
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
    </>
  )
}

function RunIcon({ r }: { r: RunView }) {
  const tone = runTone(r)
  if (tone === 'success') return <CheckIcon aria-label="Succeeded" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  if (tone === 'danger') return <XIcon aria-label="Failed" className="size-3.5 shrink-0 text-destructive" />
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <Dot tone={tone} />
    </span>
  )
}

function Runs({ build }: { build: BuildView }) {
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

function NameAndDelete({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const [name, setName] = useState(build.name)
  useEffect(() => setName(build.name), [build.name])
  const [confirming, setConfirming] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Build">
      <SettingsGroup label="build name" onSubmit={() => void run(() => actions.updateBuild(build.id, { name }))}>
        <SettingsInputRow
          id="build-name"
          aria-label="build name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          trailing={
            <Button type="submit" size="sm" variant="outline" disabled={pending || !name.trim() || name === build.name}>
              Rename
            </Button>
          }
        />
        <SettingsRow
          label="Delete build"
          description="Removes its image from Boat. Sessions on it keep their machines."
          control={
            <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsStatus error={error} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">Delete {build.name}?</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              Its saved image is removed from Boat. Sessions on it keep their machines; one that loses its machine starts again from the base.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await actions.deleteBuild(build.id)
                  setConfirming(false)
                  await navigate({ to: '/builds', search: {} })
                })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}

// ---------------------------------------------------------------- one run

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

function RunPage({ build, runId }: { build: BuildView; runId: string }) {
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
      <div className="border-y">
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

const lineTone = (l: string) =>
  /^\s*(E:|error\b|fatal\b|npm ERR!)/i.test(l) ? 'bg-destructive/[0.07] text-destructive' : /^\s*(W:|warn(ing)?\b)/i.test(l) ? 'bg-amber-500/[0.08] text-amber-800 dark:text-amber-300' : ''

/** The run's redacted output, tailed while the run is live, following the end unless scrolled up. */
function RunLog({ buildId, run }: { buildId: string; run: RunView }) {
  const client = useDorksClient()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const live = run.status === 'queued' || run.status === 'running'
  const box = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    let cancelled = false
    client
      .runLog(buildId, run.id)
      .then((l) => {
        if (!cancelled) setText(l.text)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, buildId, run.id, run.logBytes, live])
  const lines = useMemo(() => (text ? text.replace(/\n$/, '').split('\n') : []), [text])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => !q || x.l.toLowerCase().includes(q))
  }, [lines, query])
  useEffect(() => {
    const el = box.current
    if (el && stuck.current && !query) el.scrollTop = el.scrollHeight
  }, [shown, query])
  return (
    <section aria-label="Output" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b ps-4 pe-1.5">
        <span className="text-sm">Output</span>
        <span className="text-xs text-muted-foreground tabular-nums">{query ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}</span>
        <label className="ms-auto flex h-7 w-52 items-center gap-1.5 rounded-[6px] bg-foreground/[0.04] px-2">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search the output"
            placeholder="Search the output"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button size="icon-sm" variant="ghost" aria-label="Copy the output" disabled={!text} onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied the output.'))}>
          <CopyIcon />
        </Button>
      </div>
      <div
        ref={box}
        aria-label="run log"
        className="min-h-64 flex-1 overflow-auto py-2.5 font-mono text-xs leading-5"
        onScroll={(e) => {
          const el = e.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {shown.length === 0 ? (
          <p className="px-4 text-muted-foreground">{query ? 'No matches' : live ? 'Waiting for output…' : 'No output.'}</p>
        ) : (
          shown.map(({ l, n }) => (
            <div key={n} className={cn('flex pe-4', lineTone(l))}>
              <span aria-hidden className="w-12 shrink-0 pe-3.5 text-end text-muted-foreground/60 select-none">
                {n}
              </span>
              <span className="min-w-0 break-all whitespace-pre-wrap">{l}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- an agent's change

type DiffLine = { kind: ' ' | '+' | '-'; text: string }

/** A line diff (longest common subsequence); scripts are short, so the quadratic table is fine up to a sane size. */
function diffLines(a: string, b: string): DiffLine[] {
  const x = a ? a.replace(/\n$/, '').split('\n') : []
  const y = b ? b.replace(/\n$/, '').split('\n') : []
  if (x.length * y.length > 400_000) return [...x.map((text) => ({ kind: '-' as const, text })), ...y.map((text) => ({ kind: '+' as const, text }))]
  const t = Array.from({ length: x.length + 1 }, () => Array.from({ length: y.length + 1 }, () => 0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: ' ', text: x[i] })
      i++
      j++
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: '-', text: x[i++] })
    else out.push({ kind: '+', text: y[j++] })
  }
  while (i < x.length) out.push({ kind: '-', text: x[i++] })
  while (j < y.length) out.push({ kind: '+', text: y[j++] })
  return out
}

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

function ReviewPage({ build, draftId }: { build: BuildView; draftId: string }) {
  const draft = build.drafts.find((d) => d.id === draftId)
  if (!draft || (draft.status !== 'submitted' && draft.status !== 'editing'))
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader parent={<BuildCrumb build={build} />} title="Change" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="This change is no longer waiting" description={draft ? `It was ${draft.status}.` : undefined}>
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: build.id }} />}>
              Back to {build.name}
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  return <DraftReview build={build} draft={draft} />
}

/** Repositories the draft adds, removes or changes (branch or setup). */
function repoChangesOf(was: BuildRepo[], now: BuildRepo[]) {
  const before = new Map(was.map((r) => [r.repo, r]))
  const after = new Map(now.map((r) => [r.repo, r]))
  return [
    ...now.filter((r) => !before.has(r.repo)).map((r) => ({ r, what: 'Added' as const })),
    ...was.filter((r) => !after.has(r.repo)).map((r) => ({ r, what: 'Removed' as const })),
    ...now
      .filter((r) => {
        const b = before.get(r.repo)
        return b && ((b.branch ?? '') !== (r.branch ?? '') || (b.setupScript ?? '') !== (r.setupScript ?? ''))
      })
      .map((r) => ({ r, what: 'Changed' as const })),
  ]
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
function DraftReview({ build, draft }: { build: BuildView; draft: DraftView }) {
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

// ---------------------------------------------------------------- setup with an agent

/**
 * The brief a setup session starts with: with a target repository (cloned in its box), the agent works out what the repository needs
 * and prepares the build end to end on its own: try it in its box, draft, trial-run until it passes, submit for the owner's approval.
 */
export function setupBrief(buildName: string, repo: string, notes: string): string {
  const target = repo ? `so that sessions on ${repo} can start working at once. ${repo} is cloned in this box at ~/work/${repo}.` : 'so that future sessions have what they need.'
  const steps = [
    repo
      ? `Read ${repo} to work out what its development needs: README and docs, AGENTS.md / CLAUDE.md / CONTRIBUTING, package manifests and lockfiles, version files (.nvmrc, .node-version, .tool-versions, rust-toolchain, .python-version, go.mod), CI workflows, Dockerfiles and devcontainers, Makefiles and scripts. List the toolchains, system packages, CLIs, services and environment variables it uses.`
      : 'Ask me which repositories and tools this machine is for, then work out what they need.',
    'Check what this machine already has. Install what is missing here first, then run the install, build, typecheck and test commands until they work.',
    `Call machine_get, then machine_draft: a non-interactive, idempotent setup script for system tools and CLIs${repo ? `, ${repo} in repos with its own setup script for its dependency install` : ''}, a larger machine size only if builds or tests need it, and variables: plain values directly, secrets by name with why, never their values.`,
    'Run a trial with machine_run, read it with machine_logs (use wait), fix and repeat until it succeeds.',
    'Submit with machine_submit and a short note. Then tell me in a few lines what the build installs, and which secrets I need to fill in.',
  ]
  return [
    `Set up the build "${buildName}" ${target} Work end to end on your own; ask me only when a choice is truly mine (an account, a paid service, one of several deploy targets), and otherwise decide and say what you chose.`,
    ...steps.map((t, i) => `${i + 1}. ${t}`),
    ...(notes.trim() ? [`Notes from me: ${notes.trim()}`] : []),
  ].join('\n\n')
}

/** Starting a setup session: the repository it prepares the machine for (cloned in the session's box), and anything the agent should know. */
function SetupDialog({ build, open, onOpenChange }: { build: BuildView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending, error } = usePending()
  const github = useGithubRepos()
  const dorks = useDorks()
  const repos = [...new Set([...build.repos.map((r) => r.repo), ...(dorks ?? []).map((d) => d.repo).filter(Boolean), ...(github?.repos ?? [])])]
  const [chosen, setRepo] = useState<string>()
  const repo = chosen ?? repos[0] ?? ''
  const [notes, setNotes] = useState('')
  const start = () =>
    run(async () => {
      const { id } = await actions.createDork({ buildId: build.id, setup: true, ...(repo ? { repo } : {}), title: `Set up ${build.name}`, message: setupBrief(build.name, repo, notes) })
      onOpenChange(false)
      await navigate({ to: '/dorks', search: { dork: id } })
    })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="gap-2">
          <DialogTitle className="text-sm font-medium">Set up {build.name} with an agent</DialogTitle>
          <DialogDescription className="text-sm leading-5">The agent reads the repository, installs and tests what it needs, trial-runs the build and sends it to you for approval.</DialogDescription>
        </DialogHeader>
        <div data-slot="dialog-body" className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="setup-repo">Repository</FieldLabel>
            <NativeSelect id="setup-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {r}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="">None: I will tell it what the machine is for</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="setup-notes">Notes for the agent</FieldLabel>
            <Textarea id="setup-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Optional: tools you use, e.g. the Doppler CLI for secrets" />
          </Field>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={pending} onClick={() => void start()}>
            Start setup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
