import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
  LoaderIcon,
  RefreshCwIcon,
  WrapTextIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import { useTheme } from 'next-themes'
import type { MergeMethod, PullRequestComment, PullRequestSection, PullRequestView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@dorks/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { AgentMarkdown } from './ChatBlock'
import { EmptyState } from './EmptyState'
import { BAR_BUTTON } from './PreviewBrowser'
import { Tip } from './Tip'
import { PrIcon, prStatus, type PrStatusState } from './PrStatus'

// The Changes tab of Chat details, pull request first: its state, repository, title and one line of who, where and how big on
// top, then in-panel tabs for its overview (the description in collapsible sections), its files (the diff) and its comments. Before a pull
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

/** The tab look of Chat details and of the PR inside it: one 28px box selected or not, a grey fill when selected. Instant. */
export const TAB_CLASS =
  "h-7 flex-none gap-1.5 rounded-(--control-radius) px-2 py-0 transition-none text-[13px] font-normal text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground data-active:bg-foreground/[0.07] data-active:text-foreground dark:data-active:bg-foreground/[0.08] [&_svg:not([class*='size-'])]:size-3.5"

/** The PR's action buttons, as tall as the tabs beside them. */
const ACTION_BUTTON = 'h-7 px-2.5'

export const sum = (changes: FileChange[], key: 'additions' | 'deletions') => changes.reduce((n, c) => n + c[key], 0)

export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  )
}

type Section = 'overview' | 'files' | 'checks' | 'comments'

/** One PR of a stack, as the overview lists it: root first, `current` the one shown. */
export type PrStackEntry = { url: string; number?: number; state?: PrStatusState; draft?: boolean; current: boolean }

export function PullRequestPanel({
  changes,
  pr,
  pullRequest,
  stack,
  onOpenPr,
  onAsk,
}: {
  /** What the agent changed locally, shown before a pull request exists. */
  changes: FileChange[]
  /** The PR link alone, when the live read is not available (the design demo, older data). */
  pr?: { url: string; number?: number; state?: PrStatusState }
  pullRequest?: PullRequestPanelData
  /** The stack this PR is part of (PRs on each other's branches), when it is in one. */
  stack?: PrStackEntry[]
  /** Opens another of the session's PRs (a stack entry) in its tab. */
  onOpenPr?: (url: string) => void
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
  return <PullRequestView view={view} data={pullRequest} now={now} stack={stack} onOpenPr={onOpenPr} onAsk={onAsk} />
}

/** The bar above the plain file list: the PR link (or that there is none yet) and the diff stats. */
function FilesBar({
  pr,
  loading,
  error,
  onRetry,
  changes,
}: {
  pr?: { url: string; number?: number; state?: PrStatusState }
  loading?: boolean
  error?: string
  onRetry?: () => void
  changes: FileChange[]
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-y px-(--details-text)">
      <PrIcon state={pr?.state} className="size-3.5 shrink-0" />
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

function PullRequestView({
  view,
  data,
  now,
  stack,
  onOpenPr,
  onAsk,
}: {
  view: PullRequestView
  data?: PullRequestPanelData
  now: number
  stack?: PrStackEntry[]
  onOpenPr?: (url: string) => void
  onAsk?: (text: string) => void
}) {
  // A section GitHub did not return this time: say so, rather than show it as empty.
  const gone = (section: PullRequestSection) => (view.unavailable?.includes(section) ? <Unavailable section={section} onRetry={data?.refresh} /> : undefined)
  const [section, setSection] = useState<Section>('overview')
  const files: FileChange[] = view.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, patch: f.patch }))
  // Every diff starts open, files a later push adds too: what the owner folds is what is kept.
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [wrap, setWrap] = useState(false)
  const withPatch = files.filter((c) => c.patch)
  const open = new Set(withPatch.filter((c) => !closed.has(c.path)).map((c) => c.path))
  const anyOpen = open.size > 0
  return (
    <div className="flex min-h-full flex-col text-sm">
      <div className="border-t px-(--details-text) pt-5 pb-6">
        <div className="flex items-center gap-2">
          <PrState view={view} now={now} />
          <a href={view.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-muted-foreground tabular-nums hover:text-foreground hover:underline" title="Open on GitHub">
            {view.repo} #{view.number}
          </a>
        </div>
        <h2 className="mt-2 text-lg leading-snug text-pretty">{view.title}</h2>
        <PrMeta view={view} stack={stack} onOpenPr={onOpenPr} />
      </div>
      <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 items-center gap-0.5 border-b px-(--details-edge) pb-3">
          <TabsList className="h-7! min-w-0 justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none]">
            <TabsTrigger value="overview" className={TAB_CLASS}>
              Overview
            </TabsTrigger>
            <TabsTrigger value="files" className={TAB_CLASS}>
              Files <span className="text-muted-foreground tabular-nums">{view.changedFiles || files.length}</span>
            </TabsTrigger>
            {(view.checks.total > 0 || view.unavailable?.includes('checks')) && (
              <TabsTrigger value="checks" className={TAB_CLASS}>
                Checks <ChecksCount checks={view.checks} />
              </TabsTrigger>
            )}
            <TabsTrigger value="comments" className={TAB_CLASS}>
              Comments {view.comments.length > 0 && <span className="text-muted-foreground tabular-nums">{view.comments.length}</span>}
            </TabsTrigger>
          </TabsList>
          <PrActions view={view} data={data} onAsk={onAsk} />
        </div>
        <TabsContent value="overview">
          <Overview view={view} />
        </TabsContent>
        <TabsContent value="files">
          {withPatch.length > 0 && (
            <div className="flex h-9 items-center gap-0.5 border-b pr-(--details-edge) pl-(--details-text)">
              <span className="text-xs">
                <Stat additions={view.additions} deletions={view.deletions} />
              </span>
              <span className="ml-auto flex items-center gap-0.5">
                <Tip label="Wrap lines">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={`${BAR_BUTTON} size-7! transition-none ${wrap ? 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.07]' : ''}`}
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
                    className={`${BAR_BUTTON} size-7!`}
                    aria-label={anyOpen ? 'Collapse all' : 'Expand all'}
                    onClick={() => setClosed(anyOpen ? new Set(withPatch.map((c) => c.path)) : new Set())}
                  >
                    {anyOpen ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
                  </Button>
                </Tip>
              </span>
            </div>
          )}
          <FileList
            unavailable={gone('files')}
            changes={files}
            open={open}
            wrap={wrap}
            onToggle={(path) =>
              setClosed((current) => {
                const next = new Set(current)
                if (!next.delete(path)) next.add(path)
                return next
              })
            }
          />
        </TabsContent>
        <TabsContent value="checks">{gone('checks') ?? <Checks view={view} />}</TabsContent>
        <TabsContent value="comments">{gone('comments') ?? <Comments view={view} now={now} onAsk={onAsk} />}</TabsContent>
      </Tabs>
    </div>
  )
}

/** "Open", "Draft", "Merged 5m ago", "Closed": the PR's state in its colour, as on GitHub. */
function PrState({ view, now }: { view: PullRequestView; now: number }) {
  const { Icon, label, className } = prStatus(view.state, view.draft)
  return (
    <span className={`flex items-center shrink-0 gap-1.5 ${className}`}>
      <Icon className="size-3.5" />
      {label}
      {view.state === 'merged' && view.mergedAt ? ` ${ago(view.mergedAt, now)}` : ''}
    </span>
  )
}

const METHOD_KEY = 'dorks.merge-method'
const METHOD_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' }
const METHOD_BUTTON: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Merge pull request', rebase: 'Rebase and merge' }

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

/** GitHub's merge green, at the small control size. */
const MERGE_BUTTON = 'bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500'
/** A blocker the agent can fix (conflicts, failing checks): red fill, white text. */
const BLOCKER_BUTTON = 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500'

/**
 * The PR's one next step, on the right of its tabs, GitHub's way: the green merge button when it can merge (a click asks once more
 * in place, since a merge cannot be taken back), or the button that unblocks it, which names the problem itself ("Resolve
 * conflicts", "Update branch", "Fix checks"). Nothing for a draft, a merged or a closed PR: the state above says so. GitHub's
 * reason shows under the title when it refuses.
 */
function PrActions({ view, data, onAsk }: { view: PullRequestView; data?: PullRequestPanelData; onAsk?: (text: string) => void }) {
  const [method, setMethod] = useMergeMethod(view.mergeMethods)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'merge' | 'update'>()
  const [error, setError] = useState<string>()
  // A new head (a push) or state cancels a pending confirm: the owner confirms what they see.
  useEffect(() => {
    setConfirming(false)
    setError(undefined)
  }, [view.headSha, view.state])
  if (view.state !== 'open' || view.draft) return null
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
  const action = nextStep({ view, data, onAsk, method, setMethod, confirming, setConfirming, busy, run })
  if (!action && !error && !data?.error) return null
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-[1px]">
      {(error || data?.error) && (
        <Tip label={error ?? `Could not refresh from GitHub: ${data?.error}`}>
          <CircleAlertIcon className="size-3.5 text-red-600 dark:text-red-400" aria-label={error ?? data?.error} />
        </Tip>
      )}
      {action}
    </div>
  )
}

type Step = {
  view: PullRequestView
  data?: PullRequestPanelData
  onAsk?: (text: string) => void
  method: MergeMethod
  setMethod: (m: MergeMethod) => void
  confirming: boolean
  setConfirming: (c: boolean) => void
  busy?: 'merge' | 'update'
  run: (kind: 'merge' | 'update', f: () => Promise<void>) => Promise<void>
}

/** The buttons for the PR's next step: unblock it, or merge it (with the confirm). */
function nextStep({ view, data, onAsk, method, setMethod, confirming, setConfirming, busy, run }: Step): ReactNode {
  const { merge, updateBranch } = data ?? {}
  const { checks, baseRef } = view
  if (view.mergeableState === 'dirty')
    return (
      onAsk && (
        <Button size="xs" className={`${ACTION_BUTTON} ${BLOCKER_BUTTON}`} onClick={() => onAsk(`Merge ${baseRef} into this branch, resolve the conflicts, run the tests and push.`)}>
          <GitCompareArrowsIcon />
          Resolve conflicts
        </Button>
      )
    )
  if (view.mergeableState === 'behind')
    return (
      updateBranch && (
        <Button size="xs" variant="outline" className={ACTION_BUTTON} disabled={busy === 'update'} onClick={() => void run('update', () => updateBranch(view.headSha))}>
          {busy === 'update' ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
          Update branch
        </Button>
      )
    )
  if (!merge || view.mergeable === false) return null
  return (
    <>
      {checks.failed > 0 && onAsk && (
        <Button
          size="xs"
          className={`${ACTION_BUTTON} ${BLOCKER_BUTTON}`}
          onClick={() => onAsk(`The pull request's checks are failing (${checks.failing.join(', ')}). Find out why, fix it and push.`)}
        >
          <WrenchIcon />
          Fix checks
        </Button>
      )}
      <MergeButton
        view={view}
        method={method}
        setMethod={setMethod}
        confirming={confirming}
        busy={busy}
        onMerge={() => (confirming ? void run('merge', () => merge(method, view.headSha)) : setConfirming(true))}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}

/** A section GitHub did not return (rate limit, outage), with a retry. */
function Unavailable({ section, onRetry }: { section: PullRequestSection; onRetry?: () => void }) {
  return (
    <EmptyState figure="relay" title={`Couldn't load ${section} from GitHub`}>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </EmptyState>
  )
}

/** "4", or "1 failing" in red, or "2 running": the Checks tab's count. */
function ChecksCount({ checks }: { checks: PullRequestView['checks'] }) {
  if (checks.failed) return <span className="text-red-600 tabular-nums dark:text-red-400">{checks.failed}</span>
  return <span className="text-muted-foreground tabular-nums">{checks.total}</span>
}

const CHECK_ICON = {
  pass: <CircleCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />,
  fail: <CircleXIcon className="size-3.5 text-red-600 dark:text-red-400" />,
  pending: <LoaderIcon className="size-3.5 animate-spin text-amber-600 dark:text-amber-400" />,
}

/** Every check on the head commit, failing first: its outcome, its name, what it said; a row opens its log on GitHub. */
function Checks({ view }: { view: PullRequestView }) {
  return (
    <ul className="divide-y border-b">
      {view.checks.runs.map((c, i) => {
        const row = (
          <>
            {CHECK_ICON[c.outcome]}
            <span className="shrink-0">{c.name}</span>
            {c.summary && <span className="min-w-0 truncate text-xs text-muted-foreground">{c.summary}</span>}
            {c.url && <ExternalLinkIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />}
          </>
        )
        const box = 'flex items-center gap-2 p-(--details-text)'
        return (
          <li key={`${c.name}-${i}`}>
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer" className={`${box} hover:bg-foreground/[0.04]`}>
                {row}
              </a>
            ) : (
              <div className={box}>{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The merge button, its method behind the chevron (remembered per browser). A click asks once more in place, in the same two
 * buttons: the big one turns into the confirm, at the same width (both labels share one grid cell), and the chevron into a grey X that cancels.
 */
function MergeButton({
  view,
  method,
  setMethod,
  confirming,
  busy,
  onMerge,
  onCancel,
}: {
  view: PullRequestView
  method: MergeMethod
  setMethod: (m: MergeMethod) => void
  confirming: boolean
  busy?: 'merge' | 'update'
  onMerge: () => void
  onCancel: () => void
}) {
  const cell = (shown: boolean) => `col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${shown ? '' : 'invisible'}`
  return (
    <div className="flex items-center">
      <Button size="xs" className={`${ACTION_BUTTON} grid rounded-r-none ${MERGE_BUTTON}`} disabled={busy !== undefined} onClick={onMerge}>
        <span className={cell(!confirming)} aria-hidden={confirming}>
          <GitMergeIcon />
          {METHOD_BUTTON[method]}
        </span>
        <span className={cell(confirming)} aria-hidden={!confirming}>
          {busy === 'merge' ? <LoaderIcon className="animate-spin" /> : <CheckIcon />}
          Confirm merge
        </span>
      </Button>
      {confirming ? (
        <Button size="xs" variant="secondary" className="h-7 rounded-l-none px-2" disabled={busy === 'merge'} aria-label="Cancel merge" onClick={onCancel}>
          <XIcon />
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="xs" className={`h-7 rounded-l-none border-l border-l-white/25 px-2 ${MERGE_BUTTON}`} disabled={busy !== undefined} aria-label="Merge method" />}>
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
      )}
    </div>
  )
}

/**
 * One line of who and where under the title, in place of a properties block: the author, base ← head (the head copyable), the
 * stack when there is one, then the size. It wraps at narrow widths; the branch chips truncate.
 */
function PrMeta({ view, stack, onOpenPr }: { view: PullRequestView; stack?: PrStackEntry[]; onOpenPr?: (url: string) => void }) {
  const opened = new Date(view.createdAt)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground">
      <span className="flex min-w-0 items-center" title={`Opened ${opened.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}>
        <Person login={view.author.login} avatarUrl={view.author.avatarUrl} />
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <Branch name={view.baseRef} />
        <ArrowLeftIcon className="size-3 shrink-0" aria-label="from" />
        <Branch name={view.headRef} />
        <Tip label={copied ? 'Copied' : 'Copy branch name'}>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Copy branch name"
            onClick={() => void navigator.clipboard.writeText(view.headRef).then(() => setCopied(true))}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </Tip>
      </span>
      {stack && (
        <span className="flex min-w-0 items-center gap-1.5">
          Stack <StackPath stack={stack} onOpenPr={onOpenPr} />
        </span>
      )}
      <span className="flex items-center gap-2 tabular-nums">
        {view.changedFiles} {view.changedFiles === 1 ? 'file' : 'files'}
        <Stat additions={view.additions} deletions={view.deletions} />
      </span>
    </div>
  )
}

/** A branch name in mono on a faint fill, truncated when the line runs out of room. */
function Branch({ name }: { name: string }) {
  return (
    <span className="min-w-0 truncate rounded-(--control-radius) bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-xs text-foreground/80" title={name}>
      {name}
    </span>
  )
}

/** The description, its sections collapsible. */
function Overview({ view }: { view: PullRequestView }) {
  const sections = useMemo(() => descriptionSections(view.body), [view.body])
  return (
    <div>
      <div className="p-(--details-text) [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&>:last-child>:last-child]:mb-0">
        {sections.length === 0 ? (
          <p className="text-muted-foreground">No description.</p>
        ) : (
          sections.map((s, i) => (s.title ? <Collapsible key={i} title={s.title} body={s.body} /> : <AgentMarkdown key={i} className="mb-4 text-sm" children={s.body} />))
        )}
      </div>
    </div>
  )
}

/** A stack, root first: each PR's number in its state's colour, the one shown in full weight; the others open their tab. */
function StackPath({ stack, onOpenPr }: { stack: PrStackEntry[]; onOpenPr?: (url: string) => void }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 tabular-nums">
      {stack.map((p, i) => {
        const { className } = prStatus(p.state, p.draft)
        const label = p.number ? `#${p.number}` : 'PR'
        return (
          <span key={p.url} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground">→</span>}
            {p.current || !onOpenPr ? (
              <span className={`${className} ${p.current ? 'font-medium' : ''}`} aria-current={p.current || undefined}>
                {label}
              </span>
            ) : (
              <button type="button" className={`${className} hover:underline`} onClick={() => onOpenPr(p.url)}>
                {label}
              </button>
            )}
          </span>
        )
      })}
    </span>
  )
}

function Person({ login, avatarUrl, size = 16 }: { login: string; avatarUrl?: string; size?: number }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {avatarUrl && !broken ? (
        <img src={avatarUrl} alt="" width={size} height={size} className="shrink-0 rounded-full bg-muted" style={{ width: size, height: size }} onError={() => setBroken(true)} />
      ) : (
        <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-muted text-[10px] leading-none text-muted-foreground uppercase" style={{ width: size, height: size }}>
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
        <div className="px-(--details-text) py-4">
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
    <li className="p-(--details-text)">
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

function FileList({ changes, open, wrap = false, onToggle, unavailable }: { changes: FileChange[]; open?: Set<string>; wrap?: boolean; onToggle?: (path: string) => void; unavailable?: ReactNode }) {
  if (unavailable && changes.length === 0) return unavailable
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
  const box = 'flex w-full items-center gap-2 p-(--details-text) text-left font-mono text-xs'
  return (
    <li>
      {c.patch ? (
        <button type="button" aria-expanded={open} className={`${box} hover:bg-foreground/[0.04]`} onClick={onToggle}>
          {row}
        </button>
      ) : (
        <div className={box}>{row}</div>
      )}
      {open && c.patch && <LazyPatch patch={c.patch} wrap={wrap} />}
    </li>
  )
}

/** The nearest ancestor that scrolls vertically, or the viewport. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  return null
}

/** Diff lines are 20px; a collapsed run of unmodified lines takes about two. */
const DIFF_LINE_PX = 20

/**
 * A file's diff, built only once it comes within a screen or so of the view (and kept after), so a PR with dozens of files paints
 * the ones in sight at once instead of building every diff first. Until then a block of about its height holds its place.
 */
function LazyPatch({ patch, wrap }: { patch: string; wrap: boolean }) {
  const { resolvedTheme } = useTheme()
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (near || !el) return
    // Measured against the panel's own scroller: against the window, its clipping would hide the margin and build only what is in sight.
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root: scroller(el), rootMargin: '1200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near])
  if (!near) {
    const lines = patch.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++')).length
    return <div ref={ref} className="border-t" style={{ height: lines * DIFF_LINE_PX }} />
  }
  return (
    <PatchDiff
      patch={patch}
      className="block border-t [--diffs-bg:var(--background)] [--diffs-font-size:12px] [--diffs-line-height:20px] [--diffs-font-family:var(--font-mono)] [--diffs-header-font-family:var(--font-sans)]"
      options={{ diffStyle: 'unified', disableFileHeader: true, overflow: wrap ? 'wrap' : 'scroll', themeType: resolvedTheme === 'dark' ? 'dark' : 'light' }}
    />
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
