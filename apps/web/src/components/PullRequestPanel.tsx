import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LoaderIcon,
  RefreshCwIcon,
  WrapTextIcon,
} from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import { useTheme } from 'next-themes'
import type { MergeMethod, PullRequestComment, PullRequestView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { AgentMarkdown } from './ChatBlock'
import { EmptyState } from './EmptyState'
import { BAR_BUTTON } from './PreviewBrowser'
import { Tip } from './Tip'

// The Changes tab of Chat details, pull request first: its state, title and merge button on top, then in-panel tabs for its
// overview (who, where, checks, the description in collapsible sections), its files (the diff) and its comments. Before a pull
// request exists it is the plain list of files the agent changed.

export type FileChange = { path: string; additions: number; deletions: number; /** The file's unified diff (`git diff` output), when loaded: the row opens it. */ patch?: string }

/** The session's pull request as Chat details gets it: the live read and what the panel can do with it. */
export type PullRequestPanelData = {
  /** undefined while loading; null when the session has none. */
  view: PullRequestView | null | undefined
  /** Why GitHub could not be read (the last good read stays shown). */
  error?: string
  merge?: (method: MergeMethod, sha: string) => Promise<void>
  updateBranch?: (sha: string) => Promise<void>
  refresh?: () => void
}

/** The tab look Chat details uses for its own tabs: the same box selected or not, a grey fill when selected. Instant. */
export const TAB_CLASS =
  "h-[30px] flex-none gap-1.5 rounded-(--control-radius) px-2 py-0 transition-none text-sm font-normal text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground data-active:bg-foreground/[0.07] data-active:text-foreground dark:data-active:bg-foreground/[0.08] [&_svg:not([class*='size-'])]:size-3.5"

export const sum = (changes: FileChange[], key: 'additions' | 'deletions') => changes.reduce((n, c) => n + c[key], 0)

export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  )
}

type Section = 'overview' | 'files' | 'comments'

export function PullRequestPanel({
  changes,
  pr,
  pullRequest,
  onAsk,
}: {
  /** What the agent changed locally, shown before a pull request exists. */
  changes: FileChange[]
  /** The PR link alone, when the live read is not available (the design demo, older data). */
  pr?: { url: string; number?: number }
  pullRequest?: PullRequestPanelData
  onAsk?: (text: string) => void
}) {
  const view = pullRequest?.view
  // A minute clock for "Merged 5m ago"; a refresh every minute while the panel is open (the poller's updates refresh it sooner).
  const now = useNow()
  const refresh = pullRequest?.refresh
  useEffect(() => {
    if (!refresh || !view || view.state !== 'open') return
    const t = window.setInterval(refresh, 60_000)
    return () => window.clearInterval(t)
  }, [refresh, view])

  if (!view) {
    const loading = pullRequest && view === undefined && !pullRequest.error
    return (
      <div className="flex min-h-full flex-col text-sm">
        <FilesBar pr={pr} loading={loading} error={pullRequest?.error} onRetry={pullRequest?.refresh} changes={changes} />
        <FileList changes={changes} />
      </div>
    )
  }
  return <PullRequestView view={view} data={pullRequest} now={now} onAsk={onAsk} />
}

/** The bar above the plain file list: the PR link (or that there is none yet) and the diff stats. */
function FilesBar({ pr, loading, error, onRetry, changes }: { pr?: { url: string; number?: number }; loading?: boolean; error?: string; onRetry?: () => void; changes: FileChange[] }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-y pr-[14px] pl-[14px]">
      <GitPullRequestIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {pr ? (
        <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 hover:underline">
          <span className="truncate">{pr.number ? `Pull request #${pr.number}` : 'Pull request'}</span>
          <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
        </a>
      ) : (
        <span className="text-muted-foreground">{loading ? 'Loading pull request' : 'No pull request yet'}</span>
      )}
      {error && (
        <span className="min-w-0 truncate text-xs text-red-600 dark:text-red-400" title={error}>
          {error}
        </span>
      )}
      {error && onRetry && (
        <Tip label="Try again">
          <Button variant="ghost" size="icon-sm" className={`-my-2 shrink-0 ${BAR_BUTTON}`} aria-label="Try again" onClick={onRetry}>
            <RefreshCwIcon />
          </Button>
        </Tip>
      )}
      {changes.length > 0 && (
        <span className="ml-auto text-xs">
          <Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} />
        </span>
      )}
    </div>
  )
}

function PullRequestView({ view, data, now, onAsk }: { view: PullRequestView; data?: PullRequestPanelData; now: number; onAsk?: (text: string) => void }) {
  const [section, setSection] = useState<Section>('overview')
  const files: FileChange[] = view.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, patch: f.patch }))
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [wrap, setWrap] = useState(false)
  const withPatch = files.filter((c) => c.patch)
  const anyOpen = withPatch.some((c) => open.has(c.path))
  return (
    <div className="flex min-h-full flex-col text-sm">
      <div className="border-t px-[14px] pt-4 pb-4">
        <div className="flex items-center gap-2">
          <PrState view={view} now={now} />
          <span className="ml-auto flex items-center gap-0.5 -mr-[9px] -my-2">
            {data?.refresh && (
              <Tip label="Refresh">
                <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Refresh" onClick={data.refresh}>
                  <RefreshCwIcon />
                </Button>
              </Tip>
            )}
            <Tip label="Open on GitHub">
              <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label="Open on GitHub" render={<a href={view.url} target="_blank" rel="noreferrer" />} nativeButton={false}>
                <ExternalLinkIcon />
              </Button>
            </Tip>
          </span>
        </div>
        <h2 className="mt-2 text-sm font-medium text-pretty">
          {view.title} <span className="font-normal text-muted-foreground tabular-nums">#{view.number}</span>
        </h2>
        <MergeBox view={view} data={data} onAsk={onAsk} />
      </div>
      <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="min-h-0 flex-1 gap-0">
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-y p-[5px]">
          <TabsList className="h-[30px]! min-w-0 justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none]">
            <TabsTrigger value="overview" className={TAB_CLASS}>
              Overview
            </TabsTrigger>
            <TabsTrigger value="files" className={TAB_CLASS}>
              Files <span className="text-muted-foreground tabular-nums">{view.changedFiles || files.length}</span>
            </TabsTrigger>
            <TabsTrigger value="comments" className={TAB_CLASS}>
              Comments {view.comments.length > 0 && <span className="text-muted-foreground tabular-nums">{view.comments.length}</span>}
            </TabsTrigger>
          </TabsList>
          {section === 'files' && withPatch.length > 0 && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <span className="mr-1 text-xs">
                <Stat additions={view.additions} deletions={view.deletions} />
              </span>
              <Tip label="Wrap lines">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`${BAR_BUTTON} transition-none ${wrap ? 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.07]' : ''}`}
                  aria-label="Wrap lines"
                  aria-pressed={wrap}
                  onClick={() => setWrap(!wrap)}
                >
                  <WrapTextIcon />
                </Button>
              </Tip>
              <Tip label={anyOpen ? 'Collapse all' : 'Expand all'}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={BAR_BUTTON}
                  aria-label={anyOpen ? 'Collapse all' : 'Expand all'}
                  onClick={() => setOpen(anyOpen ? new Set() : new Set(withPatch.map((c) => c.path)))}
                >
                  {anyOpen ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
                </Button>
              </Tip>
            </div>
          )}
        </div>
        <TabsContent value="overview">
          <Overview view={view} />
        </TabsContent>
        <TabsContent value="files">
          <FileList
            changes={files}
            open={open}
            wrap={wrap}
            onToggle={(path) =>
              setOpen((current) => {
                const next = new Set(current)
                if (!next.delete(path)) next.add(path)
                return next
              })
            }
          />
        </TabsContent>
        <TabsContent value="comments">
          <Comments view={view} now={now} onAsk={onAsk} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** "Open", "Draft", "Merged 5m ago", "Closed": the PR's state in its colour, as on GitHub. */
function PrState({ view, now }: { view: PullRequestView; now: number }) {
  if (view.state === 'merged')
    return (
      <span className="flex items-center gap-1.5 text-violet-600 dark:text-violet-400">
        <GitMergeIcon className="size-3.5" />
        Merged {view.mergedAt ? ago(view.mergedAt, now) : ''}
      </span>
    )
  if (view.state === 'closed')
    return (
      <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
        <GitPullRequestClosedIcon className="size-3.5" />
        Closed
      </span>
    )
  if (view.draft)
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <GitPullRequestDraftIcon className="size-3.5" />
        Draft
      </span>
    )
  return (
    <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
      <GitPullRequestIcon className="size-3.5" />
      Open
    </span>
  )
}

const METHOD_KEY = 'dorks.merge-method'
const METHOD_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' }
const METHOD_BUTTON: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' }

/** The merge method last used, remembered per browser, when this repository allows it. */
function useMergeMethod(allowed: MergeMethod[]) {
  const [saved, setSaved] = useState<MergeMethod | undefined>(() => {
    try {
      return (localStorage.getItem(METHOD_KEY) as MergeMethod | null) ?? undefined
    } catch {
      return undefined
    }
  })
  const method = saved && allowed.includes(saved) ? saved : (allowed[0] ?? 'squash')
  const set = (m: MergeMethod) => {
    setSaved(m)
    try {
      localStorage.setItem(METHOD_KEY, m)
    } catch {
      /* private mode: keep it in memory */
    }
  }
  return [method, set] as const
}

type Readiness = { tone: 'ok' | 'warn' | 'bad' | 'muted'; text: string; canMerge: boolean }

/** What stands between the PR and a merge, in a few words, and whether the button should be offered. */
const count = (n: number) => `${n} ${n === 1 ? 'check' : 'checks'}`

/** "e2e failing", "2 checks running", "4 checks passed", or nothing when the PR has no checks. */
function checksText({ checks }: PullRequestView) {
  if (checks.failed) return `${checks.failing.length === checks.failed ? checks.failing.join(', ') : count(checks.failed)} failing`
  if (checks.pending) return `${count(checks.pending)} running`
  return checks.total ? `${count(checks.passed)} passed` : ''
}

function readiness(view: PullRequestView): Readiness {
  const { checks } = view
  const checkText = checksText(view)
  if (view.draft) return { tone: 'muted', text: 'Draft. Mark it ready for review on GitHub to merge.', canMerge: false }
  switch (view.mergeableState) {
    case 'dirty':
      return { tone: 'bad', text: `Conflicts with ${view.baseRef}`, canMerge: false }
    case 'behind':
      return { tone: 'warn', text: `Behind ${view.baseRef}. Update the branch to merge.`, canMerge: false }
    case 'blocked':
      return { tone: checks.failed ? 'bad' : 'warn', text: checks.failed || checks.pending ? `${checkText}. Required to merge.` : 'Waiting on a required review', canMerge: true }
    case 'unstable':
      return { tone: 'warn', text: checkText || 'Some checks are failing', canMerge: true }
    case 'unknown':
      return { tone: 'muted', text: checkText ? `${checkText}. Checking mergeability.` : 'Checking mergeability', canMerge: view.mergeable !== false }
    default:
      return { tone: checks.pending ? 'warn' : 'ok', text: checkText ? `Ready to merge · ${checkText}` : 'Ready to merge', canMerge: true }
  }
}

const TONE: Record<Readiness['tone'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  muted: 'bg-muted-foreground/50',
}

/**
 * The merge: the readiness line, then a split button (the method, remembered, behind its chevron). A click asks once more in place,
 * since a merge cannot be taken back; GitHub's own reason shows under it when it refuses.
 */
function MergeBox({ view, data, onAsk }: { view: PullRequestView; data?: PullRequestPanelData; onAsk?: (text: string) => void }) {
  const [method, setMethod] = useMergeMethod(view.mergeMethods)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'merge' | 'update'>()
  const [error, setError] = useState<string>()
  // A new head (a push) or state cancels a pending confirm: the owner confirms what they see.
  useEffect(() => {
    setConfirming(false)
    setError(undefined)
  }, [view.headSha, view.state])

  if (view.state !== 'open') return <Closed view={view} />
  const ready = readiness(view)
  const run = async (kind: 'merge' | 'update', f: () => Promise<void>) => {
    setBusy(kind)
    setError(undefined)
    try {
      await f()
      setConfirming(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(undefined)
    }
  }
  const merge = data?.merge
  return (
    <div className="mt-3">
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <span aria-hidden className={`mt-[5px] size-1.5 shrink-0 rounded-full ${TONE[ready.tone]}`} />
        <span>{ready.text}</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming && merge ? (
          <>
            <Button size="sm" disabled={busy === 'merge'} onClick={() => void run('merge', () => merge(method, view.headSha))}>
              {busy === 'merge' ? <LoaderIcon className="animate-spin" /> : <GitMergeIcon />}
              Confirm {METHOD_BUTTON[method].toLowerCase()}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === 'merge'} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">
              into <Branch name={view.baseRef} />
            </span>
          </>
        ) : (
          <>
            {merge && <MergeButton view={view} method={method} setMethod={setMethod} disabled={!ready.canMerge || busy !== undefined} onMerge={() => setConfirming(true)} />}
            <Remedies view={view} busy={busy} onAsk={onAsk} onUpdate={data?.updateBranch && ((update) => void run('update', () => update(view.headSha)))} updateBranch={data?.updateBranch} />
          </>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {data?.error && <p className="mt-2 text-xs text-muted-foreground">Could not refresh from GitHub: {data.error}</p>}
    </div>
  )
}

/** A merged or closed PR: who merged it, from which branch into which. */
function Closed({ view }: { view: PullRequestView }) {
  if (view.state === 'closed') return <p className="mt-3 text-xs text-muted-foreground">Closed without merging.</p>
  return (
    <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
      <CheckIcon className="size-3.5 text-violet-600 dark:text-violet-400" />
      {view.mergedBy ? `${view.mergedBy.login} merged` : 'Merged'} {view.headRef ? <Branch name={view.headRef} /> : null} into <Branch name={view.baseRef} />
    </p>
  )
}

/** The merge button, its method behind the chevron (remembered per browser). */
function MergeButton({ view, method, setMethod, disabled, onMerge }: { view: PullRequestView; method: MergeMethod; setMethod: (m: MergeMethod) => void; disabled: boolean; onMerge: () => void }) {
  return (
    <div className="flex items-center">
      <Button size="sm" className="rounded-r-none" disabled={disabled} onClick={onMerge}>
        <GitMergeIcon />
        {METHOD_BUTTON[method]}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" className="rounded-l-none border-l border-l-primary-foreground/20 px-2" disabled={disabled} aria-label="Merge method" />}>
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-max">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Merge method</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={method} onValueChange={(v) => setMethod(v as MergeMethod)}>
              {view.mergeMethods.map((m) => (
                <DropdownMenuRadioItem key={m} value={m}>
                  {METHOD_LABEL[m]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** What gets a blocked PR moving: bring the branch up to date, or ask the agent to resolve conflicts or fix the checks. */
function Remedies({
  view,
  busy,
  onAsk,
  onUpdate,
  updateBranch,
}: {
  view: PullRequestView
  busy?: 'merge' | 'update'
  onAsk?: (text: string) => void
  onUpdate?: (update: (sha: string) => Promise<void>) => void
  updateBranch?: (sha: string) => Promise<void>
}) {
  if (view.mergeableState === 'behind' && onUpdate && updateBranch)
    return (
      <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => onUpdate(updateBranch)}>
        {busy === 'update' && <LoaderIcon className="animate-spin" />}
        Update branch
      </Button>
    )
  if (!onAsk) return null
  if (view.mergeableState === 'dirty')
    return (
      <Button size="sm" variant="outline" onClick={() => onAsk(`Merge ${view.baseRef} into this branch, resolve the conflicts, run the tests and push.`)}>
        Ask to resolve conflicts
      </Button>
    )
  if (view.checks.failed > 0)
    return (
      <Button size="sm" variant="outline" onClick={() => onAsk(`The pull request's checks are failing (${view.checks.failing.join(', ')}). Find out why, fix it and push.`)}>
        Ask to fix checks
      </Button>
    )
  return null
}

function Branch({ name }: { name: string }) {
  return <span className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{name}</span>
}

/** Who opened it, from which branch into which, when, its checks and size; then the description, its sections collapsible. */
function Overview({ view }: { view: PullRequestView }) {
  const sections = useMemo(() => descriptionSections(view.body), [view.body])
  const opened = new Date(view.createdAt)
  const { checks } = view
  return (
    <div className="pb-6">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 px-[14px] pt-4 pb-4">
        <Meta label="Author">
          <Person login={view.author.login} avatarUrl={view.author.avatarUrl} />
        </Meta>
        <Meta label="Repository">
          <span className="truncate">
            <span className="text-muted-foreground">{view.repo.split('/')[0]}/</span>
            {view.repo.split('/')[1]}
          </span>
        </Meta>
        <Meta label="Branch">
          <span className="truncate font-mono text-xs" title={`${view.headRef} → ${view.baseRef}`}>
            {view.headRef} <span className="text-muted-foreground">→ {view.baseRef}</span>
          </span>
        </Meta>
        <Meta label="Opened">
          <span className="tabular-nums">
            {opened.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {opened.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </Meta>
        {checks.total > 0 && (
          <Meta label="Checks">
            <span className="tabular-nums">
              {checks.passed}/{checks.total} passed
              {checks.failed > 0 && <span className="text-red-600 dark:text-red-400"> · {checks.failed} failing</span>}
              {checks.pending > 0 && <span className="text-muted-foreground"> · {checks.pending} running</span>}
            </span>
          </Meta>
        )}
        <Meta label="Changes">
          <span className="text-xs">
            <Stat additions={view.additions} deletions={view.deletions} />{' '}
            <span className="text-muted-foreground">
              in {view.changedFiles} {view.changedFiles === 1 ? 'file' : 'files'}
            </span>
          </span>
        </Meta>
      </dl>
      <div className="border-t px-[14px] pt-4">
        {sections.length === 0 ? (
          <p className="text-muted-foreground">No description.</p>
        ) : (
          sections.map((s, i) => (s.title ? <Collapsible key={i} title={s.title} body={s.body} /> : <AgentMarkdown key={i} className="mb-4 text-sm" children={s.body} />))
        )}
      </div>
    </div>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end text-right">{children}</dd>
    </>
  )
}

function Person({ login, avatarUrl, size = 16 }: { login: string; avatarUrl?: string; size?: number }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {avatarUrl && !broken ? (
        <img src={avatarUrl} alt="" width={size} height={size} className="shrink-0 rounded-full bg-muted" style={{ width: size, height: size }} onError={() => setBroken(true)} />
      ) : (
        <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-muted text-[10px] text-muted-foreground uppercase" style={{ width: size, height: size }}>
          {login[0]}
        </span>
      )}
      <span className="truncate">{login}</span>
    </span>
  )
}

/** A description section under its heading, open by default, folded with the triangle like the reference. */
function Collapsible({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="mb-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-ml-1 flex items-center gap-1 rounded-(--control-radius) px-1 py-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={`size-3.5 ${open ? 'rotate-90' : ''}`} />
        {title}
      </button>
      {open && body.trim() && <AgentMarkdown className="mt-1 mb-4 text-sm" children={body} />}
    </section>
  )
}

/** The description split at its headings (`#` to `###`), HTML comments dropped; the text before the first heading has no title. */
export function descriptionSections(body: string): { title?: string; body: string }[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (!text) return []
  const out: { title?: string; body: string }[] = []
  let current: { title?: string; lines: string[] } = { lines: [] }
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = !fence && /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      if (current.title || current.lines.join('').trim()) out.push({ title: current.title, body: current.lines.join('\n').trim() })
      current = { title: h[1], lines: [] }
    } else current.lines.push(line)
  }
  if (current.title || current.lines.join('').trim()) out.push({ title: current.title, body: current.lines.join('\n').trim() })
  return out
}

const REVIEW: Record<string, { text: string; className: string }> = {
  APPROVED: { text: 'approved', className: 'text-emerald-600 dark:text-emerald-400' },
  CHANGES_REQUESTED: { text: 'requested changes', className: 'text-red-600 dark:text-red-400' },
  COMMENTED: { text: 'reviewed', className: 'text-muted-foreground' },
  DISMISSED: { text: 'review dismissed', className: 'text-muted-foreground' },
}

/** The conversation, oldest first: comments, reviews and inline comments, split by full hairlines. */
function Comments({ view, now, onAsk }: { view: PullRequestView; now: number; onAsk?: (text: string) => void }) {
  if (view.comments.length === 0) return <EmptyState figure="relay" title="No comments yet" description="Comments and reviews on the pull request show up here." />
  return (
    <div>
      <ul className="divide-y border-b">
        {view.comments.map((c) => (
          <CommentRow key={c.id} comment={c} now={now} />
        ))}
      </ul>
      {onAsk && view.state === 'open' && (
        <div className="px-[14px] py-4">
          <Button size="sm" variant="outline" onClick={() => onAsk('Read the comments and reviews on the pull request, address them, push, and reply to each one.')}>
            Ask to address comments
          </Button>
        </div>
      )}
    </div>
  )
}

function CommentRow({ comment: c, now }: { comment: PullRequestComment; now: number }) {
  const review = c.reviewState ? REVIEW[c.reviewState] : undefined
  const body = c.body.replace(/<!--[\s\S]*?-->/g, '').trim()
  return (
    <li className="px-[14px] py-3.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Person login={c.author.login} avatarUrl={c.author.avatarUrl} />
        {review && <span className={review.className}>{review.text}</span>}
        <a href={c.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-muted-foreground tabular-nums hover:text-foreground hover:underline">
          {ago(c.createdAt, now)}
        </a>
      </div>
      {c.path && (
        <div className="mt-1.5 truncate font-mono text-xs text-muted-foreground" title={c.path}>
          {c.path}
          {c.line ? `:${c.line}` : ''}
        </div>
      )}
      {body && <AgentMarkdown className="mt-1.5 text-sm" children={body} />}
    </li>
  )
}

function FileList({ changes, open, wrap = false, onToggle }: { changes: FileChange[]; open?: Set<string>; wrap?: boolean; onToggle?: (path: string) => void }) {
  const [own, setOwn] = useState<Set<string>>(() => new Set())
  const opened = open ?? own
  const toggle =
    onToggle ??
    ((path: string) =>
      setOwn((current) => {
        const next = new Set(current)
        if (!next.delete(path)) next.add(path)
        return next
      }))
  if (changes.length === 0) return <EmptyState figure="branches" title="No changes yet" description="Files the agent edits show up here, with their diff stats." />
  return (
    <ul className="divide-y border-b">
      {changes.map((c) => (
        <ChangeRow key={c.path} change={c} open={opened.has(c.path)} onToggle={() => toggle(c.path)} wrap={wrap} />
      ))}
    </ul>
  )
}

/** One changed file: its path and stats, and with a patch, a toggle that opens the diff below it (Pierre diffs, unified, no header of its own). */
function ChangeRow({ change: c, open, onToggle, wrap }: { change: FileChange; open: boolean; onToggle: () => void; wrap: boolean }) {
  const { resolvedTheme } = useTheme()
  const slash = c.path.lastIndexOf('/')
  const row = (
    <>
      {/* Without a patch the chevron's slot stays, so every path starts on the same x. */}
      <ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground ${c.patch ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`} />
      <span className="min-w-0 flex-1 truncate" title={c.path}>
        <span className="text-muted-foreground">{c.path.slice(0, slash + 1)}</span>
        {c.path.slice(slash + 1)}
      </span>
      <Stat additions={c.additions} deletions={c.deletions} />
    </>
  )
  const box = 'flex h-9 w-full items-center gap-2 px-[14px] text-left font-mono text-xs'
  return (
    <li>
      {c.patch ? (
        <button type="button" aria-expanded={open} className={`${box} hover:bg-foreground/[0.04]`} onClick={onToggle}>
          {row}
        </button>
      ) : (
        <div className={box}>{row}</div>
      )}
      {open && c.patch && (
        <PatchDiff
          patch={c.patch}
          className="block border-t [--diffs-bg:var(--background)] [--diffs-font-size:12px] [--diffs-line-height:20px] [--diffs-font-family:var(--font-mono)] [--diffs-header-font-family:var(--font-sans)]"
          options={{ diffStyle: 'unified', disableFileHeader: true, overflow: wrap ? 'wrap' : 'scroll', themeType: resolvedTheme === 'dark' ? 'dark' : 'light' }}
        />
      )}
    </li>
  )
}

/** "now", "5m ago", "2h ago", "3d ago". */
function ago(at: number, now: number) {
  const m = Math.floor((now - at) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}
