import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'
import { ActivityIcon, AppWindowIcon, FileIcon, GitMergeIcon, GitPullRequestIcon, LayersIcon, MonitorIcon, PanelLeftIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@dorks/ui/input-group'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { ComputerView, type ComputerSource } from './ComputerView'
import { EmptyState } from './EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from './ImageLightbox'
import { BAR_BUTTON, port, PreviewBrowser, useShownServers, type PreviewServer } from './PreviewBrowser'
import { Tip } from './Tip'
import { ProgressPanel, stepLine } from './ProgressPanel'
import { progressSteps, stepStatus, useProgress, type ProgressTask, type ProgressTurn } from '../lib/progress'
import { PullRequestPanel, Stat, sum, TAB_CLASS, type FileChange, type PullRequestPanelData } from './PullRequestPanel'

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
  pr?: { url: string; number?: number }
  /** The pull request read live from GitHub, with its merge; the Changes tab shows it first. */
  pullRequest?: PullRequestPanelData
  /** The dev servers the agent showed: running previews, tiles in Artifacts that open in place. */
  previews?: PreviewServer[]
  /** The agent's own computer, streamed live in the Computer tab. */
  computer?: ComputerSource
}

/** A panel Chat details can show in a tab. */
type Panel = 'progress' | 'artifacts' | 'changes' | 'computer'
/** An open tab: a panel, a pull request (by url, so a session can hold more than one later) or a New tab. */
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
  // Once the agent opens a pull request, the Changes tab is that PR, named by its number.
  const view = data.pullRequest?.view
  const prNumber = view?.number ?? data.pr?.number
  const prMerged = view?.state === 'merged'
  const prIcon = prMerged ? <GitMergeIcon /> : <GitPullRequestIcon />
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
      const text = pr?.title ?? (pr?.number ? `#${pr.number}` : 'Pull request')
      return { icon: pr?.merged ? <GitMergeIcon /> : <GitPullRequestIcon />, text, title: text }
    }
    const panel = key as Panel
    if (panel === 'changes' && prNumber) return { icon: prIcon, text: <span className="tabular-nums">#{prNumber}</span>, title: `#${prNumber}` }
    return { icon: PANEL_ICON[panel], text: PANEL_LABEL[panel], title: PANEL_LABEL[panel] }
  }
  // The session's pull requests: one today, keyed by url so more can come.
  const prs: IndexPr[] = view
    ? [{ url: view.url, title: view.title, repo: view.repo, number: view.number, additions: view.additions, deletions: view.deletions, merged: prMerged }]
    : data.pr
      ? [
          {
            url: data.pr.url,
            title: data.pr.number ? `Pull request #${data.pr.number}` : 'Pull request',
            number: data.pr.number,
            repo: repoOf(data.pr.url),
            additions: sum(changes, 'additions'),
            deletions: sum(changes, 'deletions'),
          },
        ]
      : []

  const panel = (key: TabKey) => {
    if (key.startsWith('new:'))
      return (
        <NewTab
          prs={prs}
          artifacts={data.artifacts ?? []}
          previews={data.previews ?? []}
          panelLabel={(p) => (p === 'changes' && prNumber ? `#${prNumber}` : PANEL_LABEL[p])}
          panelIcon={(p) => (p === 'changes' && prNumber ? prIcon : PANEL_ICON[p])}
          tilePreview={(p) => <TilePreview panel={p} data={data} pr={prs[0]} />}
          onOpen={(target) => tabs.replace(key, target)}
          onOpenPreview={(s) => {
            setPreview(s.url)
            tabs.replace(key, 'artifacts')
          }}
        />
      )
    if (key.startsWith('pr:')) {
      const url = key.slice(3)
      const current = view?.url === url || data.pr?.url === url
      return (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PullRequestPanel changes={current ? changes : []} pr={current ? data.pr : { url }} pullRequest={current ? data.pullRequest : undefined} onAsk={onAsk} />
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
            <Artifacts artifacts={data.artifacts ?? []} changes={changes} previews={data.previews ?? []} onOpenChanges={() => open('changes')} onOpenPreview={(s) => setPreview(s.url)} onAsk={onAsk} />
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

type IndexPr = { url: string; title: string; repo?: string; number?: number; additions: number; deletions: number; merged?: boolean }

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
  panelLabel,
  panelIcon,
  tilePreview,
  onOpen,
  onOpenPreview,
}: {
  prs: IndexPr[]
  artifacts: Artifact[]
  previews: PreviewServer[]
  panelLabel: (p: Panel) => string
  panelIcon: (p: Panel) => ReactNode
  /** What a panel's tile shows of it. */ tilePreview: (p: Panel) => ReactNode
  onOpen: (target: TabKey) => void
  onOpenPreview: (server: PreviewServer) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const match = (...names: (string | undefined)[]) => !q || names.some((n) => n?.toLowerCase().includes(q))
  const shownPrs = prs.filter((p) => match(p.title, p.repo, p.number ? `#${p.number}` : undefined))
  const shownPreviews = previews.filter((s) => match(s.name))
  const shownArtifacts = artifacts.filter((a) => (a.src || a.href) && match(a.name, a.type))
  const shownPanels = PANELS.filter((p) => match(PANEL_LABEL[p], panelLabel(p)))
  const images: LightboxImage[] = artifacts.filter((a) => a.src).map((a) => ({ id: a.id, src: a.src!, alt: a.name, caption: a.name, width: a.width, height: a.height }))
  const nothing = shownPrs.length + shownPreviews.length + shownArtifacts.length + shownPanels.length === 0
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
        {shownPanels.length > 0 && (
          <section aria-label="Panels">
            <ul className="grid grid-cols-2 gap-x-3 gap-y-4">
              {shownPanels.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    className="group/tile flex w-full flex-col gap-2 rounded-[8px] text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onClick={() => onOpen(p)}
                  >
                    <span className="flex aspect-square w-full flex-col overflow-hidden rounded-[8px] bg-foreground/[0.03] p-3 text-xs text-muted-foreground transition-colors group-hover/tile:bg-foreground/[0.05]">
                      {tilePreview(p)}
                    </span>
                    <span className="flex items-center gap-2 px-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
                      {panelIcon(p)}
                      <span className="truncate">{panelLabel(p)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {nothing && <EmptyState figure="drawer" title="No matches" />}
        {shownPrs.length > 0 && (
          <IndexSection title="Pull requests">
            {shownPrs.map((p) => (
              <li key={p.url}>
                <button type="button" className={`${INDEX_ROW} h-auto flex-col items-stretch gap-0.5 py-1.5`} onClick={() => onOpen(`pr:${p.url}`)}>
                  <span className="truncate">{p.title}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {p.merged ? <GitMergeIcon /> : <GitPullRequestIcon />}
                    <span className="truncate tabular-nums">
                      {p.repo}
                      {p.number ? `#${p.number}` : ''}
                    </span>
                    <Stat additions={p.additions} deletions={p.deletions} />
                  </span>
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
                              className="size-3.5 shrink-0 rounded-[2px] object-cover"
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

/** A word or two in the middle of an empty tile. */
const TileNote = ({ children }: { children: ReactNode }) => <span className="m-auto flex items-center gap-1.5 text-center">{children}</span>

/**
 * What a New tab's panel tile shows: Progress its latest steps and the task count, Artifacts its newest thumbnails, Changes the
 * pull request or the changed files, Computer whether it is awake. Never a blank box: a tile with nothing says so in a word.
 */
function TilePreview({ panel, data, pr }: { panel: Panel; data: ChatDetailsData; pr?: IndexPr }) {
  if (panel === 'progress') return <ProgressTile data={data} />
  if (panel === 'artifacts') return <ArtifactsTile data={data} />
  if (panel === 'changes') return <ChangesTile changes={data.changes ?? []} pr={pr} />
  return <ComputerTile computer={data.computer} />
}

/** Progress's tile status: "Working · 3 / 5 tasks", the task count, or how many steps ran. */
function progressStatus(running: boolean, tasks: ProgressTask[], steps: number) {
  const done = tasks.length > 0 ? `${tasks.filter((t) => t.status === 'completed').length} / ${tasks.length} tasks` : ''
  if (running) return done ? `Working · ${done}` : 'Working'
  return done || `${steps} steps`
}

function ProgressTile({ data }: { data: ChatDetailsData }) {
  const steps = progressSteps(data.progress ?? [])
  if (steps.length === 0) return <TileNote>No steps yet</TileNote>
  const running = steps.some((s) => stepStatus(s.block) === 'running')
  return (
    <>
      <span className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden">
        {steps.slice(-5).map((s, i, shown) => {
          const { text, mono } = stepLine(s)
          return (
            <span key={s.key} className={`truncate ${mono ? 'font-mono' : ''} ${i === shown.length - 1 ? 'text-foreground' : ''}`}>
              {text}
            </span>
          )
        })}
      </span>
      <span className="mt-3 flex items-center gap-1.5 tabular-nums">
        {running && <span aria-hidden className="size-1.5 rounded-full bg-brand" />}
        {progressStatus(running, data.tasks ?? [], steps.length)}
      </span>
    </>
  )
}

function ArtifactsTile({ data }: { data: ChatDetailsData }) {
  const items = [
    ...(data.previews ?? []).map((s) => ({ id: s.url, src: undefined as string | undefined, preview: true })),
    ...(data.artifacts ?? []).map((a) => ({ id: a.id, src: a.src, preview: false })),
  ].slice(-4)
  if (items.length === 0) return <TileNote>None yet</TileNote>
  return (
    <span className="grid flex-1 grid-cols-2 grid-rows-2 gap-1.5">
      {items.map((it) => (
        <span key={it.id} className="relative flex items-center justify-center overflow-hidden rounded-[4px] bg-foreground/[0.04]">
          {it.src ? <img src={it.src} alt="" className="size-full object-cover" /> : <AppWindowIcon className="size-4" />}
          {it.preview && <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-emerald-500" />}
        </span>
      ))}
    </span>
  )
}

function ChangesTile({ changes, pr }: { changes: FileChange[]; pr?: IndexPr }) {
  if (!pr && changes.length === 0) return <TileNote>No changes</TileNote>
  return (
    <>
      {pr ? (
        <span className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
          <span className="tabular-nums">{`${pr.repo ?? ''}#${pr.number ?? ''}`}</span>
          <span className="line-clamp-4 text-sm text-foreground">{pr.title}</span>
        </span>
      ) : (
        <span className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden font-mono">
          {changes.slice(0, 5).map((c) => (
            <span key={c.path} className="truncate">
              {c.path.split('/').pop()}
            </span>
          ))}
        </span>
      )}
      <span className="mt-3 flex items-center gap-1.5">
        <Stat additions={pr?.additions ?? sum(changes, 'additions')} deletions={pr?.deletions ?? sum(changes, 'deletions')} />
        {changes.length > 0 && <span className="tabular-nums">{changes.length} files</span>}
      </span>
    </>
  )
}

function ComputerTile({ computer: c }: { computer?: ComputerSource }) {
  const state = !c || (!c.awake && !c.used) ? 'Not used' : c.awake ? 'Awake' : 'Asleep'
  return (
    <span className="m-auto flex flex-col items-center gap-2">
      <MonitorIcon className="size-6" strokeWidth={1.5} />
      <span className="flex items-center gap-1.5">
        {state === 'Awake' && <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />}
        {state}
      </span>
    </span>
  )
}

function IndexSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
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
