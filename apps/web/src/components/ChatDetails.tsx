import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import type { SubscriptionView } from '@dorks/shared'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'
import { ActivityIcon, AppWindowIcon, FileIcon, GitPullRequestIcon, LayersIcon, MonitorIcon, PanelLeftIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@dorks/ui/input-group'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { ComputerView, type ComputerSource } from './ComputerView'
import { EmptyState } from './EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from './ImageLightbox'
import { BAR_BUTTON, port, PreviewBrowser, useShownServers, type PreviewServer } from './PreviewBrowser'
import { Tip } from './Tip'
import { ProgressPanel } from './ProgressPanel'
import { useProgress, type ProgressTask, type ProgressTurn } from '../lib/progress'
import { PullRequestPanel, Stat, sum, TAB_CLASS, type FileChange, type PrStackEntry, type PullRequestPanelData } from './PullRequestPanel'
import { PrIcon, type PrStatusState } from './PrStatus'

/** A file the agent produced in the chat: a screenshot, a design, a document. */
export type Artifact = {
  id: string
  name: string
  /** Short type label, e.g. "PNG". */ type: string
  src?: string
  href?: string
  /** Pixel size of an image, when known. */ width?: number
  height?: number
}
export type { FileChange } from './PullRequestPanel'

/** Everything Chat details can show. Missing parts show an empty state in their tab. */
export type ChatDetailsData = {
  /** The agent's work, by turn: every tool call, edit and progress message, which the thread leaves out. */
  progress?: ProgressTurn[]
  /** The agent's task list, as its latest plan left it. */
  tasks?: ProgressTask[]
  artifacts?: Artifact[]
  changes?: FileChange[]
  pr?: { url: string; number?: number; state?: PrStatusState }
  /** The headline pull request (the latest the agent opened) read live from GitHub, with its merge. */
  pullRequest?: PullRequestPanelData
  /** A hook reading any of the session's other pull requests live by url (stable across renders); without it they show their link only. */
  usePullRequest?: (url: string) => PullRequestPanelData | undefined
  /** The dev servers the agent showed: running previews, tiles in Artifacts that open in place. */
  previews?: PreviewServer[]
  /** The agent's own computer, streamed live in the Computer tab. */
  computer?: ComputerSource
  /** The pull requests the session has (it opened them, or the agent or the owner subscribed; merged and closed ones too): each gets a tab. */
  subscriptions?: SubscriptionView[]
}

/** A panel Chat details can show in a tab. */
type Panel = 'progress' | 'artifacts' | 'changes' | 'computer'
/** An open tab: a panel, a pull request (by url: a session can hold several) or a New tab. `changes` is the local diff before any PR. */
type TabKey = Panel | `pr:${string}` | `new:${string}`

const PANELS: Panel[] = ['progress', 'artifacts', 'changes', 'computer']
const PANEL_ICON: Record<Panel, ReactNode> = { progress: <ActivityIcon />, artifacts: <LayersIcon />, changes: <GitPullRequestIcon />, computer: <MonitorIcon /> }
const PANEL_LABEL: Record<Panel, string> = { progress: 'Progress', artifacts: 'Artifacts', changes: 'Changes', computer: 'Computer' }

/**
 * Chat details: the right side of a chat, full height and flush to the window's edge, split from the chat by one full-height hairline
 * (the resize handle sits on it). Its top bar is 40px, placed so its labels share the chat title's centre line (24px from the top),
 * and holds the open tabs like a browser: Progress, Artifacts, Changes, Computer and one per pull request, in any order, each closable
 * (its icon turns into an X on hover, nothing moves), then "+" for a New tab, an index of the session's pull requests, artifacts and
 * panels. The open tabs and the selected one are remembered per session. The hide button keeps ShowDetailsButton's spot.
 */
/**
 * The last Progress reveal a panel acted on, kept outside the component so a remount (hide and show, another session) does not
 * replay an old reveal over the restored tabs, while a card that opens the panel still brings Progress up.
 */
let handledReveal = 0

export function ChatDetails({
  data,
  sessionId,
  onClose,
  onGrab,
  onAsk,
  className,
}: {
  data: ChatDetailsData
  /** Whose open tabs to remember. Without it they last as long as the panel. */ sessionId?: string
  onClose?: () => void
  /** An element picked in a running preview, as agent context. */ onGrab?: (snippet: string) => void
  /** An empty state's action: puts a ready request in the composer. */ onAsk?: (text: string) => void
  className?: string
}) {
  const tabs = useOpenTabs(sessionId)
  const { open } = tabs
  // A turn's card in the thread asks for its work: bring Progress up (also when the card opened this panel).
  const { reveal } = useProgress()
  useEffect(() => {
    if (reveal !== handledReveal) open('progress')
    handledReveal = reveal
  }, [reveal, open])
  const changes = data.changes ?? []
  const view = data.pullRequest?.view
  const headline = data.pr?.url
  // Every pull request the session has, stacked ones under the PR whose branch they build on.
  const prs = sessionPrs(data)
  // The agent just opened a pull request: bring its tab up. A chat that opens with one already open keeps the tab the owner was on.
  const seenHeadline = useRef(headline)
  useEffect(() => {
    if (headline && headline !== seenHeadline.current) open(`pr:${headline}`)
    seenHeadline.current = headline
  }, [headline, open])
  // The local diff's tab becomes the PR once there is one (tabs remembered from before PRs had their own).
  const { keys, replace } = tabs
  useEffect(() => {
    if (headline && keys.includes('changes')) replace('changes', `pr:${headline}`)
  }, [headline, keys, replace])
  // The first time the agent reaches for its computer while the chat is open, show its screen; a chat that opens on a computer
  // already used keeps the tab the owner was on.
  const used = data.computer?.used ?? false
  const wasUsed = useRef(used)
  useEffect(() => {
    if (used && !wasUsed.current) open('computer')
    wasUsed.current = used
  }, [used, open])
  // The preview open in Artifacts, by URL. The agent just showed a dev server: bring Artifacts up with it open. Held here, since the
  // tab's content unmounts while hidden.
  const [preview, setPreview] = useState<string>()
  const openPreview = data.previews?.find((s) => s.url === preview)
  useShownServers(data.previews, (s) => {
    open('artifacts')
    setPreview(s.url)
  })

  const label = (key: TabKey): { icon: ReactNode; text: ReactNode; title: string } => {
    if (key.startsWith('new:')) return { icon: <SearchIcon />, text: 'New tab', title: 'New tab' }
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const pr = prs.find((p) => p.url === url)
      const number = pr?.number ?? Number(/\/pull\/(\d+)/.exec(url)?.[1])
      const text = number ? `#${number}` : 'Pull request'
      return { icon: <PrIcon state={pr?.state} draft={pr?.draft} />, text: <span className="tabular-nums">{text}</span>, title: pr?.title ?? text }
    }
    const panel = key as Panel
    return { icon: PANEL_ICON[panel], text: PANEL_LABEL[panel], title: PANEL_LABEL[panel] }
  }
  const openPr = (url: string) => open(`pr:${url}`)

  const panel = (key: TabKey) => {
    if (key.startsWith('new:'))
      return (
        <NewTab
          prs={prs}
          artifacts={data.artifacts ?? []}
          previews={data.previews ?? []}
          hidePanel={(p) => p === 'changes' && prs.length > 0}
          panelLabel={(p) => PANEL_LABEL[p]}
          panelIcon={(p) => PANEL_ICON[p]}
          computer={data.computer}
          computerOpen={tabs.keys.includes('computer')}
          onOpen={(target) => tabs.replace(key, target)}
          onOpenPreview={(s) => {
            setPreview(s.url)
            tabs.replace(key, 'artifacts')
          }}
        />
      )
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const isHeadline = url === headline || view?.url === url
      const listed = prs.find((p) => p.url === url)
      return (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isHeadline ? (
            <PullRequestPanel changes={changes} pr={data.pr} pullRequest={data.pullRequest} stack={stackOf(prs, url)} onOpenPr={openPr} onAsk={onAsk} />
          ) : (
            <OtherPr url={url} state={listed?.state} usePr={data.usePullRequest} stack={stackOf(prs, url)} onOpenPr={openPr} onAsk={onAsk} />
          )}
        </div>
      )
    }
    switch (key as Panel) {
      case 'progress':
        return <ProgressPanel turns={data.progress ?? []} tasks={data.tasks} />
      case 'artifacts':
        return openPreview ? (
          <PreviewBrowser server={openPreview} onBack={() => setPreview(undefined)} onGrab={onGrab} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <Artifacts
              artifacts={data.artifacts ?? []}
              changes={changes}
              previews={data.previews ?? []}
              onOpenChanges={() => open(headline ? `pr:${headline}` : 'changes')}
              onOpenPreview={(s) => setPreview(s.url)}
              onAsk={onAsk}
            />
          </div>
        )
      case 'changes':
        return (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PullRequestPanel changes={changes} pr={data.pr} pullRequest={data.pullRequest} onAsk={onAsk} />
          </div>
        )
      case 'computer':
        return (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t">
            <ComputerView source={data.computer} />
          </div>
        )
    }
  }

  return (
    <aside aria-label="Chat details" className={['flex h-full min-h-0 min-w-0 flex-col border-l border-border [--details-edge:10px] [--details-text:18px]', className].filter(Boolean).join(' ')}>
      <Tabs value={tabs.selected} onValueChange={(value) => tabs.select(value as TabKey)} className="min-h-0 min-w-0 flex-1 gap-0">
        {/* 40px, 4px down from the top, so its labels sit on the chat title's 24px line. */}
        <div data-tauri-drag-region className="mt-1 mb-2 flex h-10 min-w-0 shrink-0 items-center gap-0.5 px-(--details-edge)">
          <TabsList className="h-7! min-w-0 justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none]">
            {tabs.keys.map((key) => {
              const { icon, text, title } = label(key)
              return (
                <OpenTab key={key} value={key} icon={icon} title={title} onClose={() => tabs.close(key)}>
                  {text}
                </OpenTab>
              )
            })}
            <Tip label="New tab">
              <Button variant="ghost" size="icon-sm" className={`shrink-0 ${ACTION} size-7!`} aria-label="New tab" onClick={tabs.add}>
                <PlusIcon />
              </Button>
            </Tip>
          </TabsList>
          {onClose && (
            <Tip label="Hide chat details">
              <Button variant="ghost" size="icon-sm" className={`ml-auto shrink-0 ${ACTION} size-7!`} aria-label="Hide chat details" onClick={onClose}>
                <PanelLeftIcon className="rotate-180" />
              </Button>
            </Tip>
          )}
        </div>
        {tabs.keys.map((key) => (
          <TabsContent key={key} value={key} className="flex min-h-0 flex-col">
            {panel(key)}
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  )
}

/**
 * An open tab: the same 28px box selected or not (nothing moves), a grey fill when selected, a lighter one on hover. On hover (or
 * keyboard focus) its icon gives way to an X in the same spot that closes it; a middle click closes it too.
 */
function OpenTab({ value, icon, title, onClose, children }: { value: TabKey; icon: ReactNode; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="group/tab relative flex-none">
      <TabsTrigger
        value={value}
        title={title}
        className={`${TAB_CLASS} max-w-48 group-hover/tab:text-foreground dark:group-hover/tab:text-foreground group-hover/tab:not-data-active:bg-foreground/[0.04]`}
        onAuxClick={(e) => {
          if (e.button === 1) onClose()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <span className="flex shrink-0 group-hover/tab:invisible group-has-[button:focus-visible]/tab:invisible">{icon}</span>
        <span className="truncate">{children}</span>
      </TabsTrigger>
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="absolute top-1/2 left-[6px] flex size-[18px] -translate-y-1/2 items-center justify-center rounded-[4px] text-muted-foreground opacity-0 group-hover/tab:opacity-100 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

type OpenTabs = { keys: TabKey[]; selected: TabKey }
const TABS_KEY = 'dorks.chat-details-tabs.'
const DEFAULT_TABS: OpenTabs = { keys: ['progress'], selected: 'progress' }
const newTab = (): TabKey => `new:${Math.random().toString(36).slice(2, 8)}`
const isKey = (k: unknown): k is TabKey => typeof k === 'string' && ((PANELS as string[]).includes(k) || /^(pr|new):./.test(k))

function loadTabs(sessionId?: string): OpenTabs {
  if (!sessionId) return DEFAULT_TABS
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY + sessionId) ?? 'null') as Partial<OpenTabs> | null
    const keys = Array.isArray(raw?.keys) ? [...new Set(raw.keys.filter(isKey))] : []
    if (keys.length === 0) return DEFAULT_TABS
    return { keys, selected: raw?.selected && keys.includes(raw.selected) ? raw.selected : keys[0] }
  } catch {
    return DEFAULT_TABS
  }
}

/** The open tabs and the selected one, remembered per session. Opening a tab that is already open focuses it. */
function useOpenTabs(sessionId?: string) {
  const [state, setState] = useState(() => loadTabs(sessionId))
  const [loadedFor, setLoadedFor] = useState(sessionId)
  if (loadedFor !== sessionId) {
    setLoadedFor(sessionId)
    setState(loadTabs(sessionId))
  }
  useEffect(() => {
    if (!sessionId) return
    try {
      localStorage.setItem(TABS_KEY + sessionId, JSON.stringify(state))
    } catch {
      /* private mode: keep it in memory */
    }
  }, [sessionId, state])
  const open = useCallback((key: TabKey) => setState((s) => (s.keys.includes(key) ? { ...s, selected: key } : { keys: [...s.keys, key], selected: key })), [])
  return {
    keys: state.keys,
    selected: state.selected,
    open,
    select: (key: TabKey) => setState((s) => ({ ...s, selected: key })),
    add: () => open(newTab()),
    /** Closing the selected tab selects its neighbour (the next one, else the previous); closing the last leaves a New tab. */
    close: (key: TabKey) =>
      setState((s) => {
        const i = s.keys.indexOf(key)
        const keys = s.keys.filter((k) => k !== key)
        if (keys.length === 0) {
          const k = newTab()
          return { keys: [k], selected: k }
        }
        return { keys, selected: s.selected === key ? keys[Math.min(i, keys.length - 1)] : s.selected }
      }),
    /** A New tab becomes what it opened, in its place; if that is already open elsewhere, it is focused there instead. */
    replace: (key: TabKey, target: TabKey) =>
      setState((s) => {
        if (s.keys.includes(target)) return { keys: s.keys.filter((k) => k !== key), selected: target }
        return { keys: s.keys.map((k) => (k === key ? target : k)), selected: target }
      }),
  }
}

/**
 * One of the session's pull requests. `depth`: how far down a stack it sits (0: on a branch no other PR of the session has; 1: on
 * another PR's branch, as GitHub stacked PRs are; and so on). `foreign`: in another repository than the session's PRs mostly are.
 */
type IndexPr = {
  url: string
  title: string
  repo?: string
  number?: number
  additions?: number
  deletions?: number
  state?: PrStatusState
  draft?: boolean
  headRef?: string
  baseRef?: string
  depth: number
  parent?: string
}

/**
 * The session's pull requests: its subscriptions (merged and closed ones too) and its headline PR, the headline's live read
 * filling in what the subscription lacks. Ordered as stacks read: a PR, then the PRs built on its branch (by number), then the
 * next root.
 */
function sessionPrs(data: ChatDetailsData): IndexPr[] {
  const byUrl = new Map<string, Omit<IndexPr, 'depth'>>()
  for (const s of data.subscriptions ?? []) {
    byUrl.set(s.url, { url: s.url, title: s.title ?? `Pull request #${s.number}`, repo: s.repo, number: s.number, state: s.state, headRef: s.headRef, baseRef: s.baseRef })
  }
  if (data.pr) byUrl.set(data.pr.url, headlinePr(data, data.pr, byUrl.get(data.pr.url)))
  return stackOrder([...byUrl.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)))
}

/** The headline PR: its live read when there is one, else what its subscription and the stored link know. */
function headlinePr(data: ChatDetailsData, pr: NonNullable<ChatDetailsData['pr']>, known: Omit<IndexPr, 'depth'> | undefined): Omit<IndexPr, 'depth'> {
  const view = data.pullRequest?.view
  if (view && view.url === pr.url) {
    const { title, repo, number, state, draft, headRef, baseRef, additions, deletions } = view
    return { url: pr.url, title, repo, number, state, draft, headRef, baseRef, additions, deletions }
  }
  const changes = data.changes ?? []
  return {
    ...known,
    url: pr.url,
    title: known?.title ?? 'Pull request',
    repo: known?.repo ?? repoOf(pr.url),
    number: known?.number ?? pr.number,
    state: pr.state ?? known?.state,
    additions: sum(changes, 'additions'),
    deletions: sum(changes, 'deletions'),
  }
}

/** Each PR, then the PRs built on its branch (another PR of the same repo whose head is its base), depth first. */
function stackOrder(all: Omit<IndexPr, 'depth'>[]): IndexPr[] {
  const parentOf = (p: Omit<IndexPr, 'depth'>) => (p.baseRef ? all.find((o) => o !== p && o.repo === p.repo && o.headRef === p.baseRef) : undefined)
  const out: IndexPr[] = []
  const placed = new Set<string>()
  const place = (p: Omit<IndexPr, 'depth'>, depth: number, parent?: string) => {
    if (placed.has(p.url)) return
    placed.add(p.url)
    out.push({ ...p, depth, parent })
    for (const child of all) if (parentOf(child) === p) place(child, depth + 1, p.url)
  }
  for (const p of all) if (!parentOf(p)) place(p, 0)
  for (const p of all) place(p, 0) // a cycle of branches: list what is left flat
  return out
}

/** The stack a PR belongs to, root first (the PR's whole tree, in list order); undefined when it stands alone. */
function stackOf(prs: IndexPr[], url: string): PrStackEntry[] | undefined {
  const at = prs.findIndex((p) => p.url === url)
  if (at < 0) return undefined
  let root = at
  while (prs[root].depth > 0) root--
  let end = root + 1
  while (end < prs.length && prs[end].depth > 0) end++
  if (end - root < 2) return undefined
  return prs.slice(root, end).map((p) => ({ url: p.url, number: p.number, state: p.state, draft: p.draft, current: p.url === url }))
}

/** A PR of the session other than its headline: read live through the host's hook when there is one. */
function OtherPr({
  url,
  state,
  usePr,
  stack,
  onOpenPr,
  onAsk,
}: {
  url: string
  state?: PrStatusState
  usePr?: (url: string) => PullRequestPanelData | undefined
  stack?: PrStackEntry[]
  onOpenPr: (url: string) => void
  onAsk?: (text: string) => void
}) {
  const live = usePr?.(url)
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined
  return <PullRequestPanel changes={[]} pr={{ url, number, state }} pullRequest={live} stack={stack} onOpenPr={onOpenPr} onAsk={onAsk} />
}

/** "owner/name" from a GitHub pull request url. */
function repoOf(url: string) {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]
}

/** A 30px row in the New tab: an icon and a label, the hover fill of the bar's buttons. */
const INDEX_ROW =
  'flex h-[30px] w-full items-center gap-2 rounded-(--control-radius) px-2 text-left text-sm transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

/**
 * A New tab: an index of what the session holds. A search box filters the pull requests, artifacts and panels below by name; each
 * opens in this tab's place. Sections with nothing in them are left out.
 */
function NewTab({
  prs,
  artifacts,
  previews,
  hidePanel,
  panelLabel,
  panelIcon,
  computer,
  computerOpen,
  onOpen,
  onOpenPreview,
}: {
  prs: IndexPr[]
  artifacts: Artifact[]
  previews: PreviewServer[]
  /** Panels another section already lists (the local diff, once the PRs have their own rows). */ hidePanel: (p: Panel) => boolean
  panelLabel: (p: Panel) => string
  panelIcon: (p: Panel) => ReactNode
  computer?: ComputerSource
  /** The Computer tab is open: its stream is the one live view, so the window here shows the state only. */ computerOpen: boolean
  onOpen: (target: TabKey) => void
  onOpenPreview: (server: PreviewServer) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const match = (...names: (string | undefined)[]) => !q || names.some((n) => n?.toLowerCase().includes(q))
  const manyRepos = new Set(prs.map((p) => p.repo)).size > 1
  const shownPrs = prs.filter((p) => match(p.title, p.repo, p.number ? `#${p.number}` : undefined))
  const shownPreviews = previews.filter((s) => match(s.name))
  const shownArtifacts = artifacts.filter((a) => (a.src || a.href) && match(a.name, a.type))
  const shownPanels = PANELS.filter((p) => !hidePanel(p) && match(PANEL_LABEL[p], panelLabel(p)))
  const images: LightboxImage[] = artifacts.filter((a) => a.src).map((a) => ({ id: a.id, src: a.src!, alt: a.name, caption: a.name, width: a.width, height: a.height }))
  const showComputer = !!computer?.used && match('Computer')
  const nothing = shownPrs.length + shownPreviews.length + shownArtifacts.length + shownPanels.length === 0 && !showComputer
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-6 px-5 pt-[20vh] pb-10">
        <InputGroup className="h-[30px] rounded-(--control-radius) border-border bg-transparent dark:bg-transparent">
          <InputGroupAddon className="pl-2">
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            aria-label="Search pull requests, artifacts and tools"
            placeholder="Search PRs, artifacts and tools"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="text-sm"
          />
        </InputGroup>
        {showComputer && <ComputerWindow source={computer!} live={!computerOpen} onOpen={() => onOpen('computer')} />}
        {nothing && <EmptyState figure="drawer" title="No matches" />}
        {shownPrs.length > 0 && (
          <IndexSection title="Pull requests">
            {shownPrs.map((p) => (
              <li key={p.url}>
                <PrRow pr={p} showRepo={manyRepos} indent={!q} onOpen={() => onOpen(`pr:${p.url}`)} />
              </li>
            ))}
          </IndexSection>
        )}
        {shownPanels.length > 0 && (
          <IndexSection title="Tools">
            {shownPanels.map((p) => (
              <li key={p}>
                <button type="button" className={INDEX_ROW} onClick={() => onOpen(p)}>
                  {panelIcon(p)}
                  <span className="truncate">{panelLabel(p)}</span>
                </button>
              </li>
            ))}
          </IndexSection>
        )}
        {shownPreviews.length + shownArtifacts.length > 0 && (
          <ImageLightbox images={images} label="Artifacts">
            <IndexSection title="Artifacts">
              {shownPreviews.map((s) => (
                <li key={s.url}>
                  <button type="button" className={INDEX_ROW} onClick={() => onOpenPreview(s)}>
                    <AppWindowIcon />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                      {s.port ? `:${s.port}` : port(s.url)}
                    </span>
                  </button>
                </li>
              ))}
              {shownArtifacts.map((a) => {
                const index = images.findIndex((i) => i.id === a.id)
                const meta = <span className="shrink-0 text-xs text-muted-foreground">{a.type}</span>
                return (
                  <li key={a.id}>
                    {index >= 0 ? (
                      <ImageTrigger index={index} className={`${INDEX_ROW} cursor-zoom-in`} aria-label={`Open ${a.name}`}>
                        {({ imageRef, morphRef }) => (
                          <>
                            <img
                              ref={(node) => {
                                imageRef(node)
                                morphRef(node)
                              }}
                              src={a.src}
                              alt=""
                              className="size-3.5 shrink-0 rounded-[2px] object-cover outline-1 -outline-offset-1 outline-foreground/15"
                            />
                            <span className="min-w-0 flex-1 truncate">{a.name}</span>
                            {meta}
                          </>
                        )}
                      </ImageTrigger>
                    ) : a.href ? (
                      <a className={INDEX_ROW} href={a.href} target="_blank" rel="noreferrer">
                        <FileIcon />
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        {meta}
                      </a>
                    ) : null}
                  </li>
                )
              })}
            </IndexSection>
          </ImageLightbox>
        )}
      </div>
    </div>
  )
}

/** A pull request on one row: its state icon, title, number (with the repo when the session's PRs span several) and diff stats.
 * A stacked PR is indented under the PR whose branch it builds on (not while searching, when its parent may be filtered out). */
function PrRow({ pr: p, showRepo, indent, onOpen }: { pr: IndexPr; showRepo: boolean; indent: boolean; onOpen: () => void }) {
  const ref = p.number ? `${showRepo && p.repo ? p.repo : ''}#${p.number}` : p.repo
  const depth = indent ? Math.min(p.depth, 4) : 0
  return (
    <button type="button" className={INDEX_ROW} style={depth ? { paddingLeft: `${8 + depth * 18}px` } : undefined} onClick={onOpen}>
      <PrIcon state={p.state} draft={p.draft} />
      <span className="min-w-0 flex-1 truncate">{p.title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        {ref}
        {p.additions !== undefined && <Stat additions={p.additions} deletions={p.deletions ?? 0} />}
      </span>
    </button>
  )
}

/**
 * A small window on the agent's computer, between the search box and the lists: its screen at a quarter scale when it is awake
 * and the Computer tab is not open (stream links are single-use, so only one view streams at a time), else the frame with its
 * state. It takes no pointer; a click opens the Computer tab in the New tab's place.
 */
function ComputerWindow({ source, live, onOpen }: { source: ComputerSource; live: boolean; onOpen: () => void }) {
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [url, setUrl] = useState<string>()
  const { awake, fetchUrl } = source
  useEffect(() => {
    setUrl(undefined)
    if (!live || !awake) return
    let on = true
    fetchUrl({ theme }).then(
      (u) => on && setUrl(u),
      () => {},
    )
    return () => {
      on = false
    }
  }, [live, awake, fetchUrl, theme])
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/win flex w-full flex-col gap-1 rounded-[8px] text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="relative block aspect-[16/10] w-full overflow-hidden rounded-[8px] bg-app outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        {url ? (
          <iframe
            src={url}
            title="Agent's computer, preview"
            tabIndex={-1}
            aria-hidden
            referrerPolicy="no-referrer"
            allow="autoplay"
            className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <MonitorIcon className="size-6" strokeWidth={1.5} />
          </span>
        )}
      </span>
      <span className={`${INDEX_ROW} group-hover/win:bg-foreground/[0.04]`}>
        <MonitorIcon />
        <span className="flex-1">Computer</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {awake && <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />}
          {awake ? 'Awake' : 'Asleep'}
        </span>
      </span>
    </button>
  )
}

function IndexSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="px-2 text-sm font-normal text-muted-foreground">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}

/**
 * A grid of tiles split by full hairlines (each tile draws its right and bottom edge; the grid hides only the outer right one, so the last row keeps its bottom line). The first tile
 * is the code changes, when there are any.
 */
function Artifacts({
  artifacts,
  changes,
  previews,
  onOpenChanges,
  onOpenPreview,
  onAsk,
}: {
  artifacts: Artifact[]
  changes: FileChange[]
  previews: PreviewServer[]
  onOpenChanges: () => void
  onOpenPreview: (server: PreviewServer) => void
  onAsk?: (text: string) => void
}) {
  if (artifacts.length === 0 && changes.length === 0 && previews.length === 0)
    return (
      <EmptyState figure="drawer" title="No artifacts yet" description="Screenshots, running previews and files from this chat show up here.">
        {onAsk && (
          <Button size="sm" variant="outline" onClick={() => onAsk('Take a screenshot of the current UI and add it to the artifacts.')}>
            Ask for a screenshot
          </Button>
        )}
      </EmptyState>
    )
  // The images among the artifacts share one lightbox, so opening one pages through the others.
  const images: LightboxImage[] = artifacts.filter((a) => a.src).map((a) => ({ id: a.id, src: a.src!, alt: a.name, caption: a.name, width: a.width, height: a.height }))
  return (
    <ImageLightbox images={images} label="Artifacts">
      <div className="@container overflow-hidden border-t">
        <ul className="-mr-px grid grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-4">
          {changes.length > 0 && (
            <Tile onClick={onOpenChanges} thumb={() => <DiffThumb />} label={<Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} />} meta={`${changes.length} files`}>
              Code changes
            </Tile>
          )}
          {previews.map((server) => (
            <Tile
              key={server.url}
              onClick={() => onOpenPreview(server)}
              thumb={() => <PreviewThumb server={server} />}
              label={
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                  Running
                </span>
              }
              meta={server.port ? `:${server.port}` : port(server.url)}
            >
              {server.name}
            </Tile>
          ))}
          {artifacts.map((a) => {
            const index = images.findIndex((i) => i.id === a.id)
            return (
              <Tile
                key={a.id}
                image={index >= 0 ? index : undefined}
                href={a.href}
                thumb={(imageRef) => (a.src ? <img ref={imageRef} src={a.src} alt="" className="size-full object-cover" /> : null)}
                label={a.type}
              >
                {a.name}
              </Tile>
            )
          })}
        </ul>
      </div>
    </ImageLightbox>
  )
}

type ImageRef = (node: HTMLImageElement | null) => void

/** A tile: an image opens the artifacts lightbox at `image`, anything else opens `href` or runs `onClick`. */
function Tile({
  thumb,
  label,
  meta,
  image,
  href,
  onClick,
  children,
}: {
  thumb: (imageRef?: ImageRef) => ReactNode
  label: ReactNode
  meta?: string
  image?: number
  href?: string
  onClick?: () => void
  children: string
}) {
  const body = (imageRef?: ImageRef) => (
    <>
      <div className="aspect-[16/10] overflow-hidden rounded-[8px] bg-app outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">{thumb(imageRef)}</div>
      <div className="mt-3.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        {label}
        {meta && <span className="tabular-nums">{meta}</span>}
      </div>
      <div className="mt-1 truncate text-sm" title={children}>
        {children}
      </div>
    </>
  )
  const cls = 'block w-full px-(--details-text) pt-5 pb-4 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
  return (
    <li className="border-r border-b">
      {image !== undefined ? (
        <ImageTrigger index={image} className={`${cls} cursor-zoom-in`} aria-label={`Open ${children}`}>
          {/* Only the image morphs into the viewer (morphRef), not the whole tile with its labels. */}
          {({ imageRef, morphRef }) =>
            body((node) => {
              imageRef(node)
              morphRef(node)
            })
          }
        </ImageTrigger>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick}>
          {body()}
        </button>
      ) : href ? (
        <a className={cls} href={href} target="_blank" rel="noreferrer">
          {body()}
        </a>
      ) : (
        <div className={cls}>{body()}</div>
      )}
    </li>
  )
}

/**
 * A running preview's thumbnail: the live page itself, laid out at four times the tile's width and scaled down to fit, so it reads
 * like a screenshot of a desktop window. It takes no pointer or focus; the tile opens the real one.
 */
function PreviewThumb({ server }: { server: PreviewServer }) {
  return (
    <div className="relative size-full bg-white">
      <iframe
        src={server.html ? undefined : server.url}
        srcDoc={server.html}
        title={`${server.name} preview`}
        tabIndex={-1}
        aria-hidden
        loading="lazy"
        className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25"
      />
    </div>
  )
}

/** A few diff lines, drawn: the code-changes tile's thumbnail. */
function DiffThumb() {
  const rows = ['w-1/2 bg-foreground/10', 'w-3/4 bg-red-500/70', 'w-2/3 bg-emerald-500/70', 'w-4/5 bg-emerald-500/70', 'w-1/2 bg-emerald-500/70', 'w-3/5 bg-foreground/10']
  return (
    <div className="flex size-full flex-col justify-center gap-1.5 px-[18%]">
      {rows.map((r, i) => (
        <div key={i} className={`h-1.5 rounded-full ${r}`} />
      ))}
    </div>
  )
}

/** The hide/show buttons: 30px, like the tabs, with the tabs' hover. */
const ACTION = BAR_BUTTON

const OPEN_KEY = 'dorks.chat-details-open'

/** Whether Chat details is shown beside a chat, remembered per browser. Open by default. */
export function useDetailsOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const set = (next: boolean) => {
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    } catch {
      /* private mode: keep it in memory */
    }
  }
  return [open, set] as const
}

/**
 * The chat header's button that brings Chat details back. Wide windows only, like the panel itself. It sits exactly where the hide
 * button was (9px from the window's right edge, centred on the 24px line), so the toggle does not jump.
 */
export function ShowDetailsButton({ onClick }: { onClick: () => void }) {
  return (
    <Tip label="Show chat details">
      <Button variant="ghost" size="icon-sm" className={`-mr-[3px] hidden lg:inline-flex ${ACTION}`} aria-label="Show chat details" onClick={onClick}>
        <PanelLeftIcon className="rotate-180" />
      </Button>
    </Tip>
  )
}

/** Whether the window is wide enough for Chat details beside the chat (Tailwind's `lg`). */
export function useWide() {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * The chat and, when given and the window is wide, Chat details beside it in a resizable split (react-resizable-panels, through
 * shadcn's Resizable). The split is remembered. The divider is Chat details' own full-height hairline; the handle sits on it.
 */
const CHAT_WIDTH = 600

export function ChatSplit({ details, children }: { details?: ReactNode; children: ReactNode }) {
  const wide = useWide()
  const layout = useDefaultLayout({ id: 'dorks.chat-split.v4', storage: localStorage })
  const chat = usePanelRef()
  if (!details || !wide) return <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
  return (
    <ResizablePanelGroup
      resizeTargetMinimumSize={{ fine: 24, coarse: 37 }}
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      {/* The chat is 600px by default and keeps its width when the window resizes; Chat details takes everything else. */}
      <ResizablePanel id="chat" panelRef={chat} defaultSize={CHAT_WIDTH} minSize={360} groupResizeBehavior="preserve-pixel-size">
        <div className="flex h-full min-w-0">{children}</div>
      </ResizablePanel>
      {/* A click on the handle snaps the chat back to its default width. */}
      <PanelResizeHandle aria-label="Resize chat and details" className="w-0 bg-transparent" onReset={() => chat.current?.resize(CHAT_WIDTH)} />
      <ResizablePanel id="details" minSize={360}>
        {details}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
