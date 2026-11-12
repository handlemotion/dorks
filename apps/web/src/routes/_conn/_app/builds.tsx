import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { BuildRepo, BuildView, DraftView, MachineType, RunView } from '@dorks/client'
import { useBuild, useBuilds, useDorksClient, useRuns } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Input } from '@dorks/ui/input'
import { NativeSelect, NativeSelectOption } from '@dorks/ui/native-select'
import { Textarea } from '@dorks/ui/textarea'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import { Group } from '../../../components/SettingsGroup'
import { usePending } from '../../../lib/pending'

// Builds (docs/builds.md): named machine setups a session can start from. The list, and one build's page (`?build=<id>`): its setup,
// repositories, variables and size, its runs with their logs, and the drafts agents submitted for approval.

export const Route = createFileRoute('/_conn/_app/builds')({
  validateSearch: (s: Record<string, unknown>): { build?: string } => (typeof s.build === 'string' ? { build: s.build } : {}),
  component: Builds,
})

const SIZES: { value: MachineType; label: string }[] = [
  { value: 'small', label: 'Small: 2 CPU, 4 GB, $0.018/h' },
  { value: 'default', label: 'Default: 4 CPU, 8 GB, $0.036/h' },
  { value: 'large', label: 'Large: 8 CPU, 16 GB, $0.072/h' },
  { value: 'xlarge', label: 'Extra large: 16 CPU, 32 GB, $0.20/h' },
]

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

/** One line on where a build stands, for the list and the page header. */
function status(b: BuildView): string {
  if (b.activeRun) return b.activeRun.status === 'queued' ? 'Waiting to build' : `${b.activeRun.kind === 'trial' ? 'Trying' : 'Building'}: ${STEP_NAMES[b.activeRun.step ?? ''] ?? 'starting'}`
  if (!b.image) return b.lastRun?.kind === 'image' && b.lastRun.status === 'failed' ? 'Build failed' : 'Not built yet'
  if (b.image.stale) return 'Out of date'
  return `Built ${ago(b.image.at)}`
}

function Builds() {
  const { build } = Route.useSearch()
  return build ? <BuildPage id={build} /> : <BuildList />
}

function BuildList() {
  const builds = useBuilds()
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending } = usePending()
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
      New build
    </Button>
  )
  if (builds && builds.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Builds" divider={false} />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="No builds yet" description="A build is a machine set up once: tools installed, variables set, repositories cloned.">
            {newButton}
          </EmptyState>
        </div>
      </div>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Builds" actions={newButton} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="mx-auto flex w-full max-w-3xl flex-col px-3 py-3" aria-label="builds">
          {builds?.map((b) => (
            <li key={b.id}>
              <Link to="/builds" search={{ build: b.id }} className="flex items-baseline gap-3 rounded-[var(--control-radius)] px-3 py-2.5 text-sm hover:bg-foreground/[0.04]">
                <span className="min-w-0 truncate">{b.name}</span>
                {b.isDefault && <span className="text-xs text-muted-foreground">Default</span>}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {status(b)}
                  {b.drafts.some((d) => d.status === 'submitted') ? ' · a change to review' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function BuildPage({ id }: { id: string }) {
  const build = useBuild(id)
  if (build === undefined) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (build === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Builds" divider={false} />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="This build no longer exists">
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" />}>
              Back to builds
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  return <BuildDetails build={build} />
}

function BuildDetails({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const navigate = useNavigate()
  const { run, pending, error } = usePending()
  const missing = build.vars.filter((v) => v.buildTime && v.requested).map((v) => v.name)
  const startSetup = () =>
    run(async () => {
      const { id } = await actions.createDork({
        buildId: build.id,
        setup: true,
        message: `Set up this machine (the build "${build.name}"). Ask me what it needs if you are not sure, try each step in this box first, then use the machine_ tools to draft the setup, trial-run it and submit it for my approval.`,
      })
      await navigate({ to: '/dorks', search: { dork: id } })
    })
  const buildLabel = build.image ? 'Rebuild' : 'Build'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={
          <Link to="/builds" className="text-muted-foreground hover:text-foreground">
            Builds
          </Link>
        }
        subtitle={<span className="text-sm text-foreground">{build.name}</span>}
        actions={
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void startSetup()}>
              Set up with an agent
            </Button>
            <Button size="sm" variant="outline" disabled={pending || !!build.activeRun || missing.length > 0} onClick={() => void run(() => actions.startRun(build.id, 'image'))}>
              {buildLabel}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col">
          <Group title="Status">
            <p data-testid="build-status">
              {status(build)}
              {build.image?.stale && build.image.staleReason ? `. ${build.image.staleReason}` : '.'}
            </p>
            {missing.length > 0 && (
              <p className="text-muted-foreground">
                Fill in {missing.join(', ')} below before building: the setup needs {missing.length === 1 ? 'it' : 'them'}.
              </p>
            )}
            {build.activeRun && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => actions.cancelRun(build.id, build.activeRun!.id))}>
                Cancel
              </Button>
            )}
            {!build.activeRun && build.lastRun?.status === 'failed' && build.lastRun.error && (
              <pre className="whitespace-pre-wrap" role="alert">
                {build.lastRun.error}
              </pre>
            )}
            <p className="text-muted-foreground">
              {build.dorkCount === 1 ? '1 session uses it.' : `${build.dorkCount} sessions use it.`}{' '}
              {build.isDefault ? 'New sessions start on it.' : build.image ? '' : 'Build it before sessions can start on it.'}
            </p>
            {build.image && (
              <div>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(() => actions.setDefaultBuild(build.id, !build.isDefault))}>
                  {build.isDefault ? 'Stop using for new sessions' : 'Use for new sessions'}
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </Group>
          {build.drafts
            .filter((d) => d.status === 'submitted' || d.status === 'editing')
            .map((d) => (
              <DraftReview key={d.id} build={build} draft={d} />
            ))}
          <Group title="Setup script">
            <SetupScript build={build} />
          </Group>
          <Group title="Repositories">
            <Repositories build={build} />
          </Group>
          <Group title="Variables">
            <Variables build={build} />
          </Group>
          <Group title="Size">
            <Size build={build} />
          </Group>
          <Group title="Runs">
            <Runs build={build} />
          </Group>
          <Group title="Name and removal">
            <NameAndDelete build={build} />
          </Group>
        </div>
      </div>
    </div>
  )
}

function SetupScript({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [text, setText] = useState(build.setupScript)
  useEffect(() => setText(build.setupScript), [build.setupScript])
  const { run, pending, error } = usePending()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void run(() => actions.updateBuild(build.id, { setupScript: text }))
      }}
    >
      <small className="text-muted-foreground">
        Runs once, when the machine is built, as <code>user</code> with passwordless sudo in <code>/home/user</code>. Stops at the first failing command.
      </small>
      <Textarea
        aria-label="setup script"
        rows={8}
        spellCheck={false}
        className="max-w-none! font-mono text-xs"
        placeholder="sudo apt-get install -y jq"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={pending || text === build.setupScript}>
        Save
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

function Repositories({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [script, setScript] = useState('')
  const { run, pending, error } = usePending()
  const save = (repos: BuildRepo[]) => run(() => actions.updateBuild(build.id, { repos }))
  return (
    <>
      <small className="text-muted-foreground">
        Cloned into <code>~/work/owner/name</code> when the machine is built. A session fetches before it starts, so new work starts from the latest code.
      </small>
      {build.repos.length > 0 && (
        <ul aria-label="repositories">
          {build.repos.map((r) => (
            <li key={r.repo} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <code>{r.repo}</code>
                {r.branch && <span className="text-muted-foreground">{r.branch}</span>}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={pending}
                  aria-label={`remove ${r.repo}`}
                  onClick={() => void save(build.repos.filter((x) => x.repo !== r.repo))}
                >
                  Remove
                </Button>
              </div>
              {r.setupScript && <pre>{r.setupScript}</pre>}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await actions.updateBuild(build.id, {
              repos: [...build.repos, { repo: repo.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(script.trim() ? { setupScript: script } : {}) }],
            })
            setRepo('')
            setBranch('')
            setScript('')
          })
        }}
      >
        <label>
          Repository <Input aria-label="repository" placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label>
          Branch (optional) <Input aria-label="branch" placeholder="the default branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label>
          Setup in the clone (optional){' '}
          <Textarea aria-label="repository setup" rows={2} spellCheck={false} className="font-mono text-xs" placeholder="pnpm install" value={script} onChange={(e) => setScript(e.target.value)} />
        </label>
        <Button type="submit" size="sm" disabled={pending || !repo.trim()}>
          Add repository
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

function Variables({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [secret, setSecret] = useState(true)
  const [buildTime, setBuildTime] = useState(false)
  const [filling, setFilling] = useState<string | null>(null)
  const [fill, setFill] = useState('')
  const { run, pending, error } = usePending()
  return (
    <>
      <small className="text-muted-foreground">Set in every session on this machine. Mark one as needed while building to also give it to the setup script. Secret values are never displayed.</small>
      {build.vars.length > 0 && (
        <ul aria-label="variables">
          {build.vars.map((v) => (
            <li key={v.name} className="flex flex-wrap items-baseline gap-2">
              <code>{v.name}</code>
              <span className="min-w-0 truncate text-muted-foreground">
                {v.requested ? 'Waiting for a value' : v.secret ? 'Secret' : v.value}
                {v.buildTime ? ' · needed while building' : ''}
              </span>
              <span className="ml-auto flex gap-1">
                {(v.requested || v.secret) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setFilling(v.name)
                      setFill('')
                    }}
                  >
                    {v.requested ? 'Fill in' : 'Replace'}
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" disabled={pending} aria-label={`remove ${v.name}`} onClick={() => void run(() => actions.deleteBuildVar(build.id, v.name))}>
                  Remove
                </Button>
              </span>
              {filling === v.name && (
                <form
                  className="w-full"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void run(async () => {
                      await actions.setBuildVar(build.id, v.name, { value: fill })
                      setFilling(null)
                    })
                  }}
                >
                  <Input aria-label={`value of ${v.name}`} type={v.secret ? 'password' : 'text'} autoComplete="off" value={fill} onChange={(e) => setFill(e.target.value)} />
                  <Button type="submit" size="sm" disabled={pending || !fill}>
                    Save
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await actions.setBuildVar(build.id, name.trim(), { value, secret, buildTime })
            setName('')
            setValue('')
          })
        }}
      >
        <label>
          Name <Input aria-label="variable name" placeholder="NAME_IN_CAPS" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Value <Input aria-label="variable value" type={secret ? 'password' : 'text'} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="flex gap-4 font-normal">
          <label className="flex-row! items-center gap-2 font-normal!">
            <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Secret
          </label>
          <label className="flex-row! items-center gap-2 font-normal!">
            <input type="checkbox" checked={buildTime} onChange={(e) => setBuildTime(e.target.checked)} /> Needed while building
          </label>
        </div>
        <Button type="submit" size="sm" disabled={pending || !name.trim()}>
          Save variable
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

function Size({ build }: { build: BuildView }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  return (
    <>
      <NativeSelect
        aria-label="machine size"
        value={build.machineType}
        disabled={pending}
        onChange={(e) => void run(() => actions.updateBuild(build.id, { machineType: e.target.value as MachineType }))}
      >
        {SIZES.map((s) => (
          <NativeSelectOption key={s.value} value={s.value}>
            {s.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <small className="text-muted-foreground">Billed per second while a session runs. Extra large needs Boat’s $100 plan.</small>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

function Runs({ build }: { build: BuildView }) {
  const runs = useRuns(build.id)
  const { actions } = useDorksClient()
  const [open, setOpen] = useState<string | null>(null)
  const { run, pending, error } = usePending()
  const shown = open ?? runs?.[0]?.id ?? null
  return (
    <>
      <div>
        <Button size="sm" variant="outline" disabled={pending || !!build.activeRun} onClick={() => void run(() => actions.startRun(build.id, 'trial'))}>
          Try the setup
        </Button>
      </div>
      <small className="text-muted-foreground">A try runs the setup on a throwaway machine without saving it and without secrets.</small>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {runs && runs.length > 0 && (
        <ul aria-label="runs">
          {runs.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={`flex w-full items-baseline gap-2 rounded-[var(--control-radius)] px-2 py-1 text-left hover:bg-foreground/[0.04] ${r.id === shown ? 'bg-foreground/[0.07]' : ''}`}
                onClick={() => setOpen(r.id)}
              >
                <span>{r.kind === 'image' ? 'Build' : 'Try'}</span>
                <span className="text-muted-foreground">{runStatus(r)}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.startedBy === 'owner' ? '' : 'by an agent · '}
                  {ago(r.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown && <RunLog buildId={build.id} run={runs?.find((r) => r.id === shown)} runId={shown} />}
    </>
  )
}

const runStatus = (r: RunView) =>
  r.status === 'running' ? (STEP_NAMES[r.step ?? ''] ?? 'Running') : r.status === 'queued' ? 'Waiting' : r.status === 'succeeded' ? 'Succeeded' : r.status === 'cancelled' ? 'Cancelled' : 'Failed'

/** The run's redacted output, tailed while the run is live. */
function RunLog({ buildId, runId, run }: { buildId: string; runId: string; run?: RunView }) {
  const client = useDorksClient()
  const [text, setText] = useState('')
  const live = run?.status === 'queued' || run?.status === 'running'
  const bytes = run?.logBytes ?? 0
  useEffect(() => {
    let cancelled = false
    client
      .runLog(buildId, runId)
      .then((l) => {
        if (!cancelled) setText(l.text)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, buildId, runId, bytes, live])
  return (
    <>
      <pre aria-label="run log" className="max-h-96 whitespace-pre-wrap">
        {text || (live ? 'Waiting for output…' : 'No output.')}
      </pre>
      {run?.error && run.status === 'failed' && (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {run.error}
        </p>
      )}
    </>
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
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => actions.updateBuild(build.id, { name }))
        }}
      >
        <label>
          Name <Input aria-label="build name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button type="submit" size="sm" disabled={pending || !name.trim() || name === build.name}>
          Rename
        </Button>
      </form>
      <div>
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Delete build
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
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
    </>
  )
}

/** An agent's submitted change: what it changes against the build, its note, and the owner's decision. */
function DraftReview({ build, draft }: { build: BuildView; draft: DraftView }) {
  const { actions } = useDorksClient()
  const [reason, setReason] = useState('')
  const { run, pending, error } = usePending()
  const s = draft.spec
  const repos = (rs: BuildRepo[]) => rs.map((r) => `${r.repo}${r.branch ? ` (${r.branch})` : ''}${r.setupScript ? `\n  ${r.setupScript.trim().replace(/\n/g, '\n  ')}` : ''}`).join('\n') || '(none)'
  const changes: { what: string; before: string; after: string }[] = []
  if (s.setupScript !== build.setupScript) changes.push({ what: 'Setup script', before: build.setupScript || '(none)', after: s.setupScript || '(none)' })
  if (repos(s.repos) !== repos(build.repos)) changes.push({ what: 'Repositories', before: repos(build.repos), after: repos(s.repos) })
  if (s.machineType !== build.machineType) changes.push({ what: 'Size', before: build.machineType, after: s.machineType })
  const waiting = draft.status === 'editing'
  return (
    <Group title={waiting ? 'Change in progress' : 'Change to review'} label="agent draft">
      <p>
        From{' '}
        <Link to="/dorks" search={{ dork: draft.dorkId }}>
          {draft.dorkTitle || 'a session'}
        </Link>
        {waiting ? ', still being written.' : '.'}
        {draft.stale ? ' The build changed since the agent started it.' : ''}
      </p>
      {draft.note && <p className="text-muted-foreground">{draft.note}</p>}
      {changes.map((c) => (
        <div key={c.what} className="flex flex-col gap-1">
          <p className="font-medium">{c.what}</p>
          <div className="grid gap-2 md:grid-cols-2">
            <pre aria-label={`${c.what} before`} className="whitespace-pre-wrap text-muted-foreground">
              {c.before}
            </pre>
            <pre aria-label={`${c.what} after`} className="whitespace-pre-wrap">
              {c.after}
            </pre>
          </div>
        </div>
      ))}
      {draft.vars.length > 0 && (
        <ul aria-label="variable changes">
          {draft.vars.map((v) => (
            <li key={v.name}>
              <code>{v.name}</code>{' '}
              <span className="text-muted-foreground">
                {v.remove ? 'removed' : v.secret ? 'secret, you fill it in' : v.value !== undefined ? `= ${v.value}` : 'no value'}
                {v.buildTime && !v.remove ? ' · given to the setup script' : ''}
                {v.why ? ` · ${v.why}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {changes.length === 0 && draft.vars.length === 0 && <p className="text-muted-foreground">No changes against the build.</p>}
      {!waiting && (
        <>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const r = await actions.approveDraft(build.id, draft.id, draft.updatedAt)
                  if (r.missing.length) toast(`Approved. Fill in ${r.missing.join(', ')}, then build.`)
                })
              }
            >
              Approve and build
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(() => actions.rejectDraft(build.id, draft.id, reason.trim() || undefined))}>
              Reject
            </Button>
          </div>
          <Input aria-label="reason to reject" placeholder="Why not (optional, the agent reads it)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </Group>
  )
}
