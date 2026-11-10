import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'
import { AppWindowIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, WrapTextIcon, ExternalLinkIcon, GitPullRequestIcon, LayersIcon, MonitorIcon, PanelLeftIcon } from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import { useTheme } from 'next-themes'
import { Button } from '@dorks/ui/button'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { ComputerView, type ComputerSource } from './ComputerView'
import { EmptyState } from './EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from './ImageLightbox'
import { BAR_BUTTON, PreviewBrowser, useShownServers, type PreviewServer } from './PreviewBrowser'
import { Tip } from './Tip'

/** A file the agent produced in the chat: a screenshot, a design, a document. */
export type Artifact = { id: string; name: string; /** Short type label, e.g. "PNG". */ type: string; src?: string; href?: string; /** Pixel size of an image, when known. */ width?: number; height?: number }
export type FileChange = { path: string; additions: number; deletions: number; /** The file's unified diff (`git diff` output), when loaded: the row opens it. */ patch?: string }

/** Everything Chat details can show. Missing parts show an empty state in their tab. */
export type ChatDetailsData = {
  artifacts?: Artifact[]
  changes?: FileChange[]
  pr?: { url: string; number?: number }
  /** The dev servers the agent showed, listed in the Previews tab. */
  previews?: PreviewServer[]
  /** The agent's own computer, streamed live in the Computer tab. */
  computer?: ComputerSource
}

type Tab = 'artifacts' | 'changes' | 'previews' | 'computer'

/**
 * Chat details: a panel on the right of a chat, in the app's own fill with a soft hairline, inset 4px from the window and the chat, almost full height. Its tabs sit
 * inside it, at the top, as plain tabs: the selected one is a grey fill, the others are labels. Everything inside is concentric: the
 * panel's 11px radius is the tabs' 6px plus the 5px between them. Tabs and the hide button are 30px tall, with 5px around them on
 * every side. The tabs are fixed (always the same four, in the same order).
 * The tab row is placed so its labels share the chat title's centre line (24px from the top).
 */
export function ChatDetails({ data, onClose, onGrab, onAsk, className }: { data: ChatDetailsData; onClose?: () => void; /** An element picked in the Previews tab, as agent context. */ onGrab?: (snippet: string) => void; /** An empty state's action: puts a ready request in the composer. */ onAsk?: (text: string) => void; className?: string }) {
  const [tab, setTab] = useState<Tab>('artifacts')
  const changes = data.changes ?? []
  // The first time the agent reaches for its computer while the chat is open, show its screen; a chat that opens on a computer
  // already used keeps the tab the owner was on.
  const used = data.computer?.used ?? false
  const wasUsed = useRef(used)
  useEffect(() => {
    if (used && !wasUsed.current) setTab('computer')
    wasUsed.current = used
  }, [used])
  // The agent just showed a dev server: bring the Previews tab up on it. Held here, since the tab's content unmounts while hidden.
  const [opening, setOpening] = useState<string>()
  useShownServers(data.previews, (s) => {
    setTab('previews')
    setOpening(s.url)
  })
  return (
    <aside aria-label="Chat details" className={['flex h-full min-h-0 flex-col p-1', className].filter(Boolean).join(' ')}>
      {/* Same fill as the app; the only edge is a soft hairline (the --border tone), drawn as an overlay above the content so it takes no
          space and nothing inside (a diff paints its own layer) can cover it. */}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        className="relative min-h-0 min-w-0 flex-1 gap-0 overflow-hidden rounded-[11px] after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-[inherit] after:border after:border-border"
      >
        <div data-tauri-drag-region className="flex h-10 min-w-0 shrink-0 items-center gap-0.5 p-[5px]">
          <TabsList className="h-[30px]! min-w-0 justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none]">
            <DetailsTab value="artifacts" icon={<LayersIcon />}>Artifacts</DetailsTab>
            <DetailsTab value="changes" icon={<GitPullRequestIcon />} count={changes.length || undefined}>Changes</DetailsTab>
            <DetailsTab value="previews" icon={<AppWindowIcon />}>Previews</DetailsTab>
            <DetailsTab value="computer" icon={<MonitorIcon />}>Computer</DetailsTab>
          </TabsList>
          {onClose && (
            <Tip label="Hide chat details">
              <Button variant="ghost" size="icon-sm" className={`ml-auto shrink-0 ${ACTION}`} aria-label="Hide chat details" onClick={onClose}>
                <PanelLeftIcon className="rotate-180" />
              </Button>
            </Tip>
          )}
        </div>
        <TabsContent value="artifacts" className="flex min-h-0 flex-col overflow-y-auto">
          <Artifacts artifacts={data.artifacts ?? []} changes={changes} onOpenChanges={() => setTab('changes')} onAsk={onAsk} />
        </TabsContent>
        <TabsContent value="changes" className="min-h-0 overflow-y-auto">
          <Changes changes={changes} pr={data.pr} />
        </TabsContent>
        <TabsContent value="computer" className="mx-px mb-px flex min-h-0 flex-col overflow-hidden rounded-b-[9px] border-t">
          <ComputerView source={data.computer} />
        </TabsContent>
        <TabsContent value="previews" className="mx-px mb-px flex min-h-0 flex-col overflow-hidden rounded-b-[9px]">
          <PreviewBrowser servers={data.previews} open={opening} onOpened={() => setOpening(undefined)} onGrab={onGrab} onAsk={onAsk} />
        </TabsContent>
      </Tabs>
    </aside>
  )
}

/** A plain tab: the same 32px box selected or not (nothing moves), a grey fill when selected, a lighter one on hover. Instant. */
function DetailsTab({ value, icon, count, children }: { value: Tab; icon: ReactNode; count?: number; children: ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="h-[30px] flex-none gap-1.5 rounded-(--control-radius) px-2 py-0 transition-none text-sm font-normal text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground data-active:bg-foreground/[0.07] data-active:text-foreground dark:data-active:bg-foreground/[0.08] [&_svg:not([class*='size-'])]:size-3.5"
    >
      {icon}
      {children}
      {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
    </TabsTrigger>
  )
}


const sum = (changes: FileChange[], key: 'additions' | 'deletions') => changes.reduce((n, c) => n + c[key], 0)

function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{' '}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  )
}

/**
 * A grid of tiles split by full hairlines (each tile draws its right and bottom edge; the grid hides only the outer right one, so the last row keeps its bottom line). The first tile
 * is the code changes, when there are any.
 */
function Artifacts({ artifacts, changes, onOpenChanges, onAsk }: { artifacts: Artifact[]; changes: FileChange[]; onOpenChanges: () => void; onAsk?: (text: string) => void }) {
  if (artifacts.length === 0 && changes.length === 0) return (
      <EmptyState figure="drawer" title="No artifacts yet" description="Screenshots, designs and files from this chat show up here.">
        {onAsk && <Button size="sm" variant="outline" onClick={() => onAsk('Take a screenshot of the current UI and add it to the artifacts.')}>Ask for a screenshot</Button>}
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
function Tile({ thumb, label, meta, image, href, onClick, children }: { thumb: (imageRef?: ImageRef) => ReactNode; label: ReactNode; meta?: string; image?: number; href?: string; onClick?: () => void; children: string }) {
  const body = (imageRef?: ImageRef) => (
    <>
      <div className="aspect-[16/10] overflow-hidden rounded-[8px] bg-app">{thumb(imageRef)}</div>
      <div className="mt-3.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        {label}
        {meta && <span className="tabular-nums">{meta}</span>}
      </div>
      <div className="mt-1 truncate text-sm" title={children}>{children}</div>
    </>
  )
  const cls = 'block w-full px-5 pt-5 pb-4 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
  return (
    <li className="border-r border-b">
      {image !== undefined ? (
        <ImageTrigger index={image} className={`${cls} cursor-zoom-in`} aria-label={`Open ${children}`}>
          {/* Only the image morphs into the viewer (morphRef), not the whole tile with its labels. */}
          {({ imageRef, morphRef }) => body((node) => { imageRef(node); morphRef(node) })}
        </ImageTrigger>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick}>{body()}</button>
      ) : href ? (
        <a className={cls} href={href} target="_blank" rel="noreferrer">{body()}</a>
      ) : (
        <div className={cls}>{body()}</div>
      )}
    </li>
  )
}

/** A few diff lines, drawn: the code-changes tile's thumbnail. */
function DiffThumb() {
  const rows = ['w-1/2 bg-foreground/10', 'w-3/4 bg-red-500/70', 'w-2/3 bg-emerald-500/70', 'w-4/5 bg-emerald-500/70', 'w-1/2 bg-emerald-500/70', 'w-3/5 bg-foreground/10']
  return (
    <div className="flex size-full flex-col justify-center gap-1.5 px-[18%]">
      {rows.map((r, i) => <div key={i} className={`h-1.5 rounded-full ${r}`} />)}
    </div>
  )
}

function Changes({ changes, pr }: { changes: FileChange[]; pr?: ChatDetailsData['pr'] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [wrap, setWrap] = useState(false)
  const withPatch = changes.filter((c) => c.patch)
  const anyOpen = withPatch.some((c) => open.has(c.path))
  const toggle = (path: string) => setOpen((current) => {
    const next = new Set(current)
    if (!next.delete(path)) next.add(path)
    return next
  })
  return (
    <div className="flex min-h-full flex-col text-sm">
      {/* Icons line up with the tab icons above (14px from the panel edge); the buttons sit 5px from the right, like the tab bar's. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-y pr-[5px] pl-[14px]">
        <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
        {pr ? (
          <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 hover:underline">
            <span className="truncate">{pr.number ? `Pull request #${pr.number}` : 'Pull request'}</span>
            <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-muted-foreground">No pull request yet</span>
        )}
        {changes.length > 0 && <span className={`ml-auto text-xs ${withPatch.length > 0 ? "mr-1" : "pr-[9px]"}`}><Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} /></span>}
        {withPatch.length > 0 && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Tip label="Wrap lines">
              <Button variant="ghost" size="icon-sm" className={`${BAR_BUTTON} transition-none ${wrap ? 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.07]' : ''}`} aria-label="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                <WrapTextIcon />
              </Button>
            </Tip>
            <Tip label={anyOpen ? 'Collapse all' : 'Expand all'}>
              <Button variant="ghost" size="icon-sm" className={BAR_BUTTON} aria-label={anyOpen ? 'Collapse all' : 'Expand all'} onClick={() => setOpen(anyOpen ? new Set() : new Set(withPatch.map((c) => c.path)))}>
                {anyOpen ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
              </Button>
            </Tip>
          </div>
        )}
      </div>
      {changes.length === 0 ? (
        <EmptyState figure="branches" title="No changes yet" description="Files the agent edits show up here, with their diff stats." />
      ) : (
        <ul className="divide-y border-b">
          {changes.map((c) => <ChangeRow key={c.path} change={c} open={open.has(c.path)} onToggle={() => toggle(c.path)} wrap={wrap} />)}
        </ul>
      )}
    </div>
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
        <button type="button" aria-expanded={open} className={`${box} hover:bg-foreground/[0.04]`} onClick={onToggle}>{row}</button>
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

/** The hide/show buttons: 30px, like the tabs, with the tabs' hover. */
const ACTION = BAR_BUTTON

const OPEN_KEY = 'dorks.chat-details-open'

/** Whether Chat details is shown beside a chat, remembered per browser. Open by default. */
export function useDetailsOpen() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) !== '0' } catch { return true }
  })
  const set = (next: boolean) => {
    setOpen(next)
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0') } catch { /* private mode: keep it in memory */ }
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
      <Button variant="ghost" size="icon-sm" className={`-mr-[11px] hidden lg:inline-flex ${ACTION}`} aria-label="Show chat details" onClick={onClick}>
        <PanelLeftIcon className="rotate-180" />
      </Button>
    </Tip>
  )
}

/** Whether the window is wide enough for Chat details beside the chat (Tailwind's `lg`). */
function useWide() {
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
 * shadcn's Resizable). The split is remembered. The divider is invisible: the panel's 4px inset already separates the two.
 */
const CHAT_WIDTH = 600

export function ChatSplit({ details, children }: { details?: ReactNode; children: ReactNode }) {
  const wide = useWide()
  const layout = useDefaultLayout({ id: 'dorks.chat-split.v4', storage: localStorage })
  const chat = usePanelRef()
  if (!details || !wide) return <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
  return (
    <ResizablePanelGroup resizeTargetMinimumSize={{ fine: 24, coarse: 37 }} orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
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
