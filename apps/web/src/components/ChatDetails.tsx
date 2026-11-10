import { useEffect, useState, type ReactNode } from 'react'
import { useDefaultLayout } from 'react-resizable-panels'
import { ExternalLinkIcon, GitPullRequestIcon, GlobeIcon, LayersIcon, MonitorIcon, ChevronsLeftIcon, ChevronsRightIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@dorks/ui/tabs'
import { EmptyState } from './EmptyState'
import { ImageLightbox, ImageTrigger, type LightboxImage } from './ImageLightbox'
import { BAR_BUTTON, PreviewBrowser } from './PreviewBrowser'

/** A file the agent produced in the chat: a screenshot, a design, a document. */
export type Artifact = { id: string; name: string; /** Short type label, e.g. "PNG". */ type: string; src?: string; href?: string; /** Pixel size of an image, when known. */ width?: number; height?: number }
export type FileChange = { path: string; additions: number; deletions: number }

/** Everything Chat details can show. Missing parts show an empty state in their tab. */
export type ChatDetailsData = {
  artifacts?: Artifact[]
  changes?: FileChange[]
  pr?: { url: string; number?: number }
  previewUrl?: string
  /** An inline page for the Browser tab instead of a URL (same-origin, so the element picker works); the dev demo uses it. */
  previewHtml?: string
}

type Tab = 'artifacts' | 'changes' | 'browser' | 'computer'

/**
 * Chat details: a panel on the right of a chat, in the app's own fill with a soft hairline, inset 4px from the window and the chat, almost full height. Its tabs sit
 * inside it, at the top, as plain tabs: the selected one is a grey fill, the others are labels. Everything inside is concentric: the
 * panel's 11px radius is the tabs' 6px plus the 5px between them. Tabs and the hide button are 30px tall, with 5px around them on
 * every side. The tabs are fixed (always the same four, in the same order).
 * The tab row is placed so its labels share the chat title's centre line (24px from the top).
 */
export function ChatDetails({ data, onClose, onGrab, onAsk, className }: { data: ChatDetailsData; onClose?: () => void; /** An element picked in the Browser tab, as agent context. */ onGrab?: (snippet: string) => void; /** An empty state's action: puts a ready request in the composer. */ onAsk?: (text: string) => void; className?: string }) {
  const [tab, setTab] = useState<Tab>('artifacts')
  const changes = data.changes ?? []
  return (
    <aside aria-label="Chat details" className={['flex h-full min-h-0 flex-col p-1', className].filter(Boolean).join(' ')}>
      {/* Same fill as the app; the only edge is a soft hairline (the --border tone), drawn as an inset outline so it takes no space. */}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        className="min-h-0 flex-1 gap-0 overflow-hidden rounded-[11px] outline outline-1 -outline-offset-1 outline-border"
      >
        <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-0.5 p-[5px]">
          <TabsList className="h-[30px]! gap-0.5 rounded-none bg-transparent p-0">
            <DetailsTab value="artifacts" icon={<LayersIcon />}>Artifacts</DetailsTab>
            <DetailsTab value="changes" icon={<GitPullRequestIcon />} count={changes.length || undefined}>Changes</DetailsTab>
            <DetailsTab value="browser" icon={<GlobeIcon />}>Browser</DetailsTab>
            <DetailsTab value="computer" icon={<MonitorIcon />}>Computer</DetailsTab>
          </TabsList>
          {onClose && (
            <Button variant="ghost" size="icon-sm" className={`ml-auto ${ACTION}`} aria-label="Hide chat details" title="Hide chat details" onClick={onClose}>
              <ChevronsRightIcon />
            </Button>
          )}
        </div>
        <TabsContent value="artifacts" className="flex min-h-0 flex-col overflow-y-auto">
          <Artifacts artifacts={data.artifacts ?? []} changes={changes} onOpenChanges={() => setTab('changes')} onAsk={onAsk} />
        </TabsContent>
        <TabsContent value="changes" className="min-h-0 overflow-y-auto">
          <Changes changes={changes} pr={data.pr} />
        </TabsContent>
        <TabsContent value="computer" className="flex min-h-0 flex-col border-t">
          <EmptyState figure="laptop" title="No computer in use" description="When the agent uses a computer, its screen shows here." />
        </TabsContent>
        <TabsContent value="browser" className="mx-px mb-px flex min-h-0 flex-col overflow-hidden rounded-b-[9px]">
          <PreviewBrowser url={data.previewUrl} html={data.previewHtml} onGrab={onGrab} onAsk={onAsk} />
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
  return (
    <div className="flex min-h-full flex-col text-sm">
      {/* Icons line up with the tab icons above (14px from the panel edge). */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-y px-[14px]">
        <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
        {pr ? (
          <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 hover:underline">
            <span className="truncate">{pr.number ? `Pull request #${pr.number}` : 'Pull request'}</span>
            <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-muted-foreground">No pull request yet</span>
        )}
        {changes.length > 0 && <span className="ml-auto text-xs"><Stat additions={sum(changes, 'additions')} deletions={sum(changes, 'deletions')} /></span>}
      </div>
      {changes.length === 0 ? (
        <EmptyState figure="branches" title="No changes yet" description="Files the agent edits show up here, with their diff stats." />
      ) : (
        <ul className="divide-y">
          {changes.map((c) => {
            const slash = c.path.lastIndexOf('/')
            return (
              <li key={c.path} className="flex h-9 items-center gap-3 px-[14px] font-mono text-xs">
                <span className="min-w-0 flex-1 truncate" title={c.path}>
                  <span className="text-muted-foreground">{c.path.slice(0, slash + 1)}</span>
                  {c.path.slice(slash + 1)}
                </span>
                <Stat additions={c.additions} deletions={c.deletions} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
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
    <Button variant="ghost" size="icon-sm" className={`-mr-[3px] hidden lg:inline-flex ${ACTION}`} aria-label="Show chat details" title="Show chat details" onClick={onClick}>
      <ChevronsLeftIcon />
    </Button>
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
 * shadcn's Resizable). The split is remembered. The handle is invisible: the panel's 4px inset already separates the two.
 */
export function ChatSplit({ details, children }: { details?: ReactNode; children: ReactNode }) {
  const wide = useWide()
  const layout = useDefaultLayout({ id: 'dorks.chat-split', storage: localStorage })
  if (!details || !wide) return <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel id="chat" minSize={360}>
        <div className="flex h-full min-w-0">{children}</div>
      </ResizablePanel>
      <ResizableHandle className="w-0 bg-transparent after:w-2" />
      <ResizablePanel id="details" defaultSize="50%" minSize={360} maxSize="75%">
        {details}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
